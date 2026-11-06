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
import {
  collectRoutingTargets,
  getConfigPaths,
  type LoadConfigOptions,
  type ConfigObservationMetadata as LoaderConfigObservationMetadata,
  loadConfigWithSources,
  type SourceAwareConfigResult,
} from './lib/config.js'
import {
  discoverSkills,
  type SkillDiscoveryIssueCode,
} from './lib/discovered-skills.js'
import { isMainModule } from './lib/main-module.js'
import {
  cleanup,
  exportPersonas,
  MANIFEST_FILENAME,
  preview,
  refresh,
  resolveAgentsRoot,
} from './lib/pi-subagents-export.js'
import {
  formatReviewArtifactSuccessMessage,
  formatReviewArtifactValidationFailure,
  isLegacyReviewArtifact,
  parseValidateReviewArtifactArguments,
  readReviewArtifact,
  resolveReviewArtifactPath,
  VALIDATE_REVIEW_ARTIFACT_USAGE,
  type ValidateReviewArtifactArguments,
} from './lib/review-artifact-path.js'
import { ReviewArtifactSchema } from './lib/review-artifact-schema.js'
import {
  type ReadChunk,
  runReviewReturnValidator,
} from './lib/review-return-validator.js'
import {
  type RoutingFieldSource,
  type RoutingResolution,
  resolveRouting,
} from './lib/routing-resolver.js'
import {
  runSearchCli,
  type SearchCliOptions,
  type SearchCliSettingsLoad,
} from './lib/search-cli.js'
import {
  type InspectedRoot,
  type InspectedSource,
  inspectSearch,
  type SearchInspection,
} from './lib/search-external-sources.js'
import {
  configEntryExists,
  displaySafe,
  loadUserLevelSearchSettings,
  MAX_PROJECT_CONFIG_BYTES,
  readTextBounded,
  type UserLevelConfigDirOptions,
} from './lib/search-user-config.js'
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
  validate-review-artifact <path> [--allow-outside-artifact-root]
                               Validate a ce:review run artifact
                               The <path> argument is required by design; no artifact discovery is performed.
                               --allow-outside-artifact-root skips the requirement that <path> resolve
                               inside .context/systematic/ce-review, for validating artifacts copied from
                               CI, issues, or fixtures. Not for the ce:review parent's own run artifact.
                               Exit statuses: 0 valid artifact, 1 validation failure,
                               2 operational failure, 3 legacy artifact with no schema_version
  search <query...> [--dir <path>] [--kind solution|plan|brainstorm|ideation|all|external] [--limit <1-20>]
                               Search the project's past work by symptom, error text, module or topic,
                               and print ranked hits: docs/solutions learnings (the default kind),
                               docs/plans, docs/brainstorms and docs/ideation. --kind all ranks every
                               kind together; --kind external searches the external sources you
                               allowed, ranked per source; --limit then applies to each source,
                               at most 5 per source. An external hit prints as <source>/<path>; strip the
                               source name for a path inside one of the source's roots (with several
                               roots, the first that has the file). The project root is the nearest
                               ancestor of --dir (default: the current directory) that holds .git.
                               Reads search settings from your user config. A project config can
                               propose external sources but cannot allow them or switch search off.
                               Exit statuses: 0 results, no hits, or search disabled; 2 usage error
                               Use -- to end options, for a query that starts with a dash
  validate-review-return       Validate one raw ce:review persona return read from stdin
                               Reads exactly one JSON document (max 1 MiB) and checks it against the
                               raw reviewer return schema. No files are read or written; accepts no
                               arguments or output flags.
                               Exit statuses: 0 valid return, 1 malformed/empty/oversized/schema-invalid,
                               2 operational failure (usage, TTY, stdin read)
  config [subcommand]          Configuration management
    show [--json]              Show configuration (--json for a machine-readable resolved view)
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
  systematic validate-review-artifact --allow-outside-artifact-root /path/to/external-artifact.json
  systematic validate-review-return < reviewer-return.json
  systematic search "tests fail only on retry"
  systematic search flaky retry --limit 5
  systematic list agents
  systematic config show
  systematic config show --json
  systematic setup --harness opencode
  systematic setup --harness pi
  systematic pi-subagents preview
  systematic pi-subagents export
  systematic pi-subagents export --scope global
  systematic pi-subagents refresh
  systematic pi-subagents cleanup
`

const CONFIG_SHOW_USAGE = `Usage: systematic config show [--json]

Options:
  --json    Print a machine-readable resolved view (active profile, fallback,
            and per-agent/harness routing) instead of prose. No raw file
            contents in JSON mode.
`

const PI_SUBAGENTS_USAGE = `Usage: systematic pi-subagents <subcommand> [--scope project|global]

Subcommands:
  preview   Show what export would do (no writes)
  export    Write persona files to agents dir
  refresh   Replace stale owned files from current source, and remove unchanged
            owned files for personas that are no longer exported (edited files
            stay and are listed as still active)
  cleanup   Remove all generated files and manifest

Scope:
  project   <cwd>/.pi/agents (default)
  global    $PI_CODING_AGENT_DIR/agents or ~/.pi/agent/agents
`

export interface CapabilityCliRoots {
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
): ValidateReviewArtifactArguments | undefined {
  const commandIndex = argv[0] === 'systematic' ? 1 : 0
  if (argv[commandIndex] !== 'validate-review-artifact') return undefined
  return parseValidateReviewArtifactArguments(argv.slice(commandIndex + 1))
}

function runValidateReviewArtifact(
  options: ValidateReviewArtifactCliOptions,
): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const parsedArgs = validateReviewArtifactArgument(options.argv)
  if (parsedArgs === undefined) {
    errorSink(VALIDATE_REVIEW_ARTIFACT_USAGE)
    return 2
  }

  const resolved = resolveReviewArtifactPath(
    parsedArgs.path,
    options.cwd ?? process.cwd(),
    { allowOutsideArtifactRoot: parsedArgs.allowOutsideArtifactRoot },
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
    for (const line of formatReviewArtifactValidationFailure(
      result.error.issues,
    )) {
      errorSink(line)
    }
    return 1
  }

  outputSink(
    formatReviewArtifactSuccessMessage(parsedArgs.allowOutsideArtifactRoot),
  )
  return 0
}

export function runValidateReviewArtifactCli(
  options: ValidateReviewArtifactCliOptions,
): number {
  return runValidateReviewArtifact(options)
}

interface ValidateReviewReturnCliOptions {
  readonly argv: readonly string[]
  readonly fd?: number
  readonly isTTY?: boolean
  readonly readChunk?: ReadChunk
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

function runValidateReviewReturn(
  options: ValidateReviewReturnCliOptions,
): number {
  return runReviewReturnValidator({
    argv: options.argv,
    fd: options.fd ?? 0,
    isTTY: options.isTTY ?? process.stdin.isTTY === true,
    readChunk: options.readChunk,
    outputSink: options.outputSink ?? ((message) => console.log(message)),
    errorSink: options.errorSink ?? ((message) => console.error(message)),
  })
}

export function runValidateReviewReturnCli(
  options: ValidateReviewReturnCliOptions,
): number {
  return runValidateReviewReturn(options)
}

/**
 * The directory options the user-level search reader takes, from the loader's.
 * A key left out means "read the environment default", so only set keys pass.
 */
function userLevelDirOptions(
  options: LoadConfigOptions | undefined,
): UserLevelConfigDirOptions {
  return {
    ...(options?.homeDir !== undefined && { homeDir: options.homeDir }),
    ...(options?.userConfigDir !== undefined && {
      userConfigDir: options.userConfigDir,
    }),
    ...(options !== undefined &&
      Object.hasOwn(options, 'customConfigDir') && {
        customConfigDir: options.customConfigDir,
      }),
  }
}

/**
 * The settings loader `systematic search` injects into `runSearchCli`: the
 * full config loader, so the project-config strip warning for `search.enabled`
 * or `search.allow_project_sources` reaches stderr. The loader gets the start
 * directory as given and finds the repository root itself, so a directory with
 * no repository keeps its unresolved path. A thrown load, an invalid file of
 * any kind (user, local, custom or project), or an invalid `search` block all
 * give `unreadable: true`, which makes the core add the `config unreadable`
 * note to the results. A project config cannot change `enabled` or the allow
 * list. It may propose `search.sources`, but the loader validates and
 * discards them: the per-call external reader is their only consumer, and
 * reads the project file's `search` block on its own.
 *
 * The full loader drops a whole file that fails validation, so a valid
 * `search.enabled: false` next to a bad sibling key would be lost. When a
 * source is invalid, or the load throws, the settings come from the user-level
 * reader instead, which validates the `search` block on its own (the same
 * reader the `systematic-search` bin uses), so the opt-out still holds. Its
 * warnings join the loader's, and a thrown load adds the exception message.
 * Each message appears once, and a file the loader already named as
 * unreadable is not named a second time by the fallback. Never throws.
 */
export function loadSearchSettingsForCli(
  startDir: string,
  configOptions?: LoadConfigOptions,
): SearchCliSettingsLoad {
  const warnings: string[] = []
  // The loader names every file it could not parse before it can throw, so the
  // fallback adds only the `search` problems inside files that did parse.
  const fallback = () => {
    const user = loadUserLevelSearchSettings(userLevelDirOptions(configOptions))
    const failed = new Set(user.readFailures)
    return {
      settings: user.settings,
      warnings: user.warnings.filter((message) => !failed.has(message)),
    }
  }
  try {
    const loaded = loadConfigWithSources(startDir, {
      ...configOptions,
      invalidSource: 'report',
      warningSink: (message) => warnings.push(message),
    })
    const invalidSource = loaded.metadata.sources.some(
      (source) => source.presence === 'invalid',
    )
    if (!invalidSource) {
      return {
        settings: loaded.config.search,
        warnings: uniqueMessages(warnings),
        unreadable: loaded.config.searchUnreadable === true,
      }
    }
    warnings.push(
      '[systematic] A Systematic config file could not be read, so search results carry a `config unreadable` note. Run `systematic config show` for details.',
    )
    const user = fallback()
    warnings.push(...user.warnings)
    return {
      settings: user.settings,
      warnings: uniqueMessages(warnings),
      unreadable: true,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const user = fallback()
    warnings.push(
      `[systematic] The Systematic config could not be loaded (${displaySafe(detail)}), so search results carry a \`config unreadable\` note. Search settings come from the user-level files alone.`,
      ...user.warnings,
    )
    return {
      settings: user.settings,
      warnings: uniqueMessages(warnings),
      unreadable: true,
    }
  }
}

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages)]
}

/**
 * What `systematic search` hands `runSearchCli` besides its argv: the settings
 * loader and the config directories `--kind external` reads its allow list and
 * user sources from. Both take the same override, so one `configOptions`
 * reaches the settings loader and the external reader alike. Left out,
 * both read the home directory and `OPENCODE_CONFIG_DIR`.
 */
export function searchCliInputs(
  configOptions?: LoadConfigOptions,
): Pick<SearchCliOptions, 'loadSettings' | 'configOptions'> {
  return {
    loadSettings: (startDir) =>
      loadSearchSettingsForCli(startDir, configOptions),
    configOptions: userLevelDirOptions(configOptions),
  }
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

function formatRoutingModel(model: string | null | undefined): string {
  if (model === undefined) return '(unset)'
  if (model === null) return 'null (inherit)'
  return model
}

function formatRoutingQualifier(qualifier: string | undefined): string {
  return qualifier === undefined ? '(none)' : qualifier
}

/**
 * `level`/`form` describe SHAPE provenance (agent vs category, block vs
 * flat); `origin` (when known -- see `RoutingFieldSource.origin`'s doc
 * comment) appends FILE provenance, distinguishing `'project-profile'`
 * (an advisory, project-sourced active profile bundle) from `'user'`,
 * `'custom'`, `'user-profile'`, and `'custom-profile'`. This is the
 * `config show` surface that makes a fully-absorbed advisory bundle
 * (every target reads `user`, never `project-profile`, even though a
 * project profile is active) distinguishable from the bundle not existing
 * at all -- the whole reason this attribution is tracked.
 */
function formatRoutingSource(source: RoutingFieldSource | undefined): string {
  if (source === undefined) return '(n/a)'
  return source.origin === undefined
    ? `${source.level}/${source.form}`
    : `${source.level}/${source.form}, ${source.origin}`
}

function printProfileSummary(loaded: SourceAwareConfigResult): void {
  const metadata = loaded.metadata
  const activeLabel = metadata.activeProfile ?? 'none'
  const selectedByLabel = metadata.profileSelectorSource ?? '(none)'
  console.log(`  Active profile: ${activeLabel}`)
  console.log(`  Selected by:    ${selectedByLabel}`)
  // Absent (not printed empty) when no profile is active -- mirrors
  // `activeProfileSourcePath` being `null` in that case, and `Fallback:`'s
  // existing conditional-print pattern just below.
  if (loaded.activeProfileSourcePath !== null) {
    console.log(`  Defined in:     ${loaded.activeProfileSourcePath}`)
  }

  if (metadata.profileFallback) {
    const usedLabel = metadata.profileFallback.usedDefault
      ? `your default profile "${metadata.profileFallback.usedDefault}"`
      : 'base configuration (no default profile is set)'
    console.log(
      `  Fallback:       requested "${metadata.profileFallback.requested}" is not defined; used ${usedLabel}`,
    )
  }
}

/**
 * Print one line per overlaid target per harness: the resolved `model`,
 * qualifier (`variant` on opencode, `thinking` on pi), and which layer
 * supplied each (`level/form`, or `(n/a)` when nothing resolved). Reuses
 * the same `resolveRouting` call and `collectRoutingTargets` enumeration
 * the loader's post-merge qualifier check already performs, so this table
 * is diagnostically consistent with what actually gets validated at load
 * time -- never a second, independently-computed view. Prints resolved
 * routing values only: never environment values, never raw file contents
 * beyond what the sections above already print.
 */
/**
 * The merged `disabled_agents` set for a loaded config, in the shape
 * `collectRoutingTargets` expects. Shared by `printRoutingTable` and
 * `buildConfigShowJson` so a disabled agent (or one whose effective
 * overlay sets `disable: true`) is excluded from `config show`'s routing
 * table/JSON output, consistent with the loader's own post-merge check
 * (`assertRoutingInvariants`).
 */
function disabledAgentsSet(loaded: SourceAwareConfigResult): Set<string> {
  return new Set(loaded.config.disabled_agents ?? [])
}

function printRoutingTable(loaded: SourceAwareConfigResult): void {
  const targets = collectRoutingTargets(
    loaded.overlays,
    disabledAgentsSet(loaded),
  ).sort((left, right) =>
    `${left.category}/${left.agentKey}`.localeCompare(
      `${right.category}/${right.agentKey}`,
    ),
  )

  if (targets.length === 0) {
    console.log('  No per-agent or per-category overlays are defined.')
    return
  }

  for (const target of targets) {
    console.log(`  ${target.agentKey} (${target.category}):`)
    for (const harness of ['opencode', 'pi'] as const) {
      const resolution = resolveRouting({
        harness,
        overlays: loaded.overlays,
        piSubagentsOverlays: loaded.piSubagentsOverlays,
        target,
      })
      const qualifierName = harness === 'opencode' ? 'variant' : 'thinking'
      console.log(
        `    ${harness}: model=${formatRoutingModel(resolution.model)} (${formatRoutingSource(resolution.source.model)}), ` +
          `${qualifierName}=${formatRoutingQualifier(resolution.qualifier)} (${formatRoutingSource(resolution.source.qualifier)})`,
      )
    }
  }
}

/** Returns false when the configuration failed to load, so the caller can exit non-zero the way `--json` already does. */
function printResolvedSection(): boolean {
  let loaded: SourceAwareConfigResult
  try {
    loaded = loadConfigWithSources(process.cwd())
  } catch (error) {
    // Surface the same message `--json` already returns (see
    // buildConfigShowJson). Without it the user sees only "unavailable"
    // and has no way to learn which file or key rejected the load.
    //
    // Both lines go to stderr, together: this is the failure report, and
    // splitting it across streams would leave either half unreadable. The
    // `--json` branch keeps its envelope on stdout because that document is
    // the machine-readable output, error field included.
    console.error(
      'Resolved configuration: unavailable (the configuration failed to load).',
    )
    console.error(
      `  Reason: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }

  const { metadata, overlays } = loaded
  const hasProfileSelection =
    metadata.activeProfile !== null || metadata.profileSelectorSource !== null
  const hasOverlays =
    Object.keys(overlays.agents).length > 0 ||
    Object.keys(overlays.categories).length > 0

  console.log('\nResolved configuration:')
  // A project file that failed is left out of everything below. Say so first,
  // so the values that follow are not read as including it.
  if (loaded.skippedProject !== undefined) {
    console.log(
      `  Project config skipped: ${displaySafe(loaded.skippedProject.path)} (${displaySafe(loaded.skippedProject.reason)}). Its settings are not applied.`,
    )
  }

  if (!hasProfileSelection && !hasOverlays) {
    console.log(
      '  No profiles are selected and no per-agent/category overlays are defined.',
    )
    return true
  }

  printProfileSummary(loaded)
  console.log('')
  console.log('  Routing:')
  printRoutingTable(loaded)
  return true
}

interface ConfigShowJsonRoutingResolution {
  readonly model: string | null | undefined
  readonly qualifier: string | undefined
  readonly source: {
    readonly model: RoutingFieldSource | undefined
    readonly qualifier: RoutingFieldSource | undefined
  }
}

/** Picks only the three documented fields off a `RoutingResolution`, deliberately dropping the internal `legacyPiSubagentsThinkingPresent` flag from the public `--json` shape. */
function toJsonRoutingResolution(
  resolution: RoutingResolution,
): ConfigShowJsonRoutingResolution {
  return {
    model: resolution.model,
    qualifier: resolution.qualifier,
    source: resolution.source,
  }
}

/**
 * The config files `config show` can read. Local files carry the selected
 * path even when absent, like `user`; `custom` and `customLocal` are null
 * without a custom directory; `ignoredProject` is the `.opencode/` file a
 * repo-root project file shadows, or null.
 */
interface ConfigShowJsonLocations {
  readonly user: string
  readonly userLocal: string
  readonly project: string
  readonly custom: string | null
  readonly customLocal: string | null
  readonly ignoredProject: string | null
}

function toJsonLocations(
  paths: ReturnType<typeof getConfigPaths>,
): ConfigShowJsonLocations {
  return {
    user: paths.userConfig,
    userLocal: paths.userLocalConfig,
    project: paths.projectConfig,
    custom: paths.customConfig ?? null,
    customLocal: paths.customLocalConfig ?? null,
    ignoredProject: paths.ignoredProjectConfig ?? null,
  }
}

/**
 * What search does for this project, from the bin-safe readers: they never
 * throw, so the section is available even when the full load fails. Rooted at
 * the same checkout root the locations block shows.
 */
function inspectSearchForConfigShow(
  paths: ReturnType<typeof getConfigPaths>,
): SearchInspection {
  return inspectSearch({ checkoutRoot: paths.projectRoot })
}

interface ConfigShowJsonSuccess {
  readonly locations: ConfigShowJsonLocations
  /** Present only when the project config file failed and was left out. `reason` holds no value and no file content. */
  readonly projectSkipped?: { readonly path: string; readonly reason: string }
  readonly activeProfile: string | null
  readonly profileSelectorSource: LoaderConfigObservationMetadata['profileSelectorSource']
  /** The (non-canonical) path of the file that defined the active profile's bundle, or `null` when no profile is active. See `SourceAwareConfigResult.activeProfileSourcePath`'s doc comment for why this is file-paths-only, same as the rest of `locations`. */
  readonly activeProfileSourcePath: string | null
  readonly profileFallback: LoaderConfigObservationMetadata['profileFallback']
  readonly routing: ReadonlyArray<{
    readonly target: { readonly agentKey: string; readonly category: string }
    readonly opencode: ConfigShowJsonRoutingResolution
    readonly pi: ConfigShowJsonRoutingResolution
  }>
  readonly search: SearchInspection
}

/**
 * A load failure (e.g. an invalid config file) is reported as `{ error }`
 * instead of silently emitting a `routing: []` success shape with no
 * indication anything went wrong. The caller (`configShow`) exits
 * non-zero for this shape.
 */
interface ConfigShowJsonError {
  readonly locations: ConfigShowJsonLocations
  readonly error: string
  readonly search: SearchInspection
}

type ConfigShowJsonOutput = ConfigShowJsonSuccess | ConfigShowJsonError

/**
 * Builds the `--json` output for `config show`: file paths only (never raw
 * file contents), the resolved profile state, the per-target routing
 * table -- the same resolver calls `printRoutingTable` makes, just
 * collected into data instead of printed lines, so the two modes can never
 * diagnostically disagree -- and the search section.
 */
function buildConfigShowJson(): ConfigShowJsonOutput {
  const paths = getConfigPaths(process.cwd())
  const locations = toJsonLocations(paths)
  const search = inspectSearchForConfigShow(paths)

  let loaded: SourceAwareConfigResult
  try {
    loaded = loadConfigWithSources(process.cwd())
  } catch (error) {
    return {
      locations,
      error: error instanceof Error ? error.message : String(error),
      search,
    }
  }

  const targets = collectRoutingTargets(
    loaded.overlays,
    disabledAgentsSet(loaded),
  ).sort((left, right) =>
    `${left.category}/${left.agentKey}`.localeCompare(
      `${right.category}/${right.agentKey}`,
    ),
  )

  const routing = targets.map((target) => ({
    target,
    opencode: toJsonRoutingResolution(
      resolveRouting({
        harness: 'opencode',
        overlays: loaded.overlays,
        piSubagentsOverlays: loaded.piSubagentsOverlays,
        target,
      }),
    ),
    pi: toJsonRoutingResolution(
      resolveRouting({
        harness: 'pi',
        overlays: loaded.overlays,
        piSubagentsOverlays: loaded.piSubagentsOverlays,
        target,
      }),
    ),
  }))

  return {
    locations,
    ...(loaded.skippedProject !== undefined && {
      projectSkipped: loaded.skippedProject,
    }),
    activeProfile: loaded.metadata.activeProfile,
    profileSelectorSource: loaded.metadata.profileSelectorSource,
    activeProfileSourcePath: loaded.activeProfileSourcePath,
    profileFallback: loaded.metadata.profileFallback,
    routing,
    search,
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function formatSourceRoot(root: InspectedRoot): string {
  const state =
    root.present === null ? '' : root.present ? ' (present)' : ' (missing)'
  return `${displaySafe(root.path)}${state}`
}

function printSearchSource(source: InspectedSource): void {
  console.log(`    ${displaySafe(source.name)} [${source.status}]`)
  console.log(`      origin:  ${source.origin}`)
  if (source.status === 'dropped invalid') {
    console.log(`      reason:  ${displaySafe(source.reason)}`)
  } else {
    if (source.status === 'root rejected') {
      console.log(`      reason:  ${displaySafe(source.reason)}`)
    }
    console.log(`      format:  ${source.format}`)
    for (const root of source.roots) {
      console.log(`      root:    ${formatSourceRoot(root)}`)
    }
    if (source.exclude.length > 0) {
      console.log(
        `      exclude: ${source.exclude.map((pattern) => displaySafe(pattern)).join(', ')}`,
      )
    }
  }
  for (const warning of source.warnings) {
    console.log(`      warning: ${warning}`)
  }
}

/**
 * Prints the Search section: the same data `--json` carries under `search`,
 * as resolved values. A local config file is never echoed.
 */
function printSearchSection(search: SearchInspection): void {
  console.log('\nSearch:')
  console.log(`  Enabled:        ${yesNo(search.enabled)}`)
  console.log(`  Project root:   ${displaySafe(search.projectRoot)}`)
  console.log(
    `  Allow list:     ${
      search.allowProjectSources.length === 0
        ? '(empty)'
        : search.allowProjectSources
            .map((entry) => displaySafe(entry))
            .join(', ')
    }`,
  )
  console.log(`  Project allowed: ${yesNo(search.projectAllowed)}`)
  if (search.userConfigUnreadable) {
    console.log('  A user-level config file could not be fully read.')
  }
  if (search.projectConfigUnreadable) {
    console.log('  The project config file could not be read.')
  }

  console.log('\n  External sources:')
  if (search.sources.length === 0) console.log('    (none)')
  for (const source of search.sources) printSearchSource(source)
  for (const warning of search.warnings) {
    console.log(`    warning: ${warning}`)
  }

  console.log('\n  Built-in kinds:')
  for (const kind of search.builtIn) {
    console.log(
      `    ${kind.kind.padEnd(10)} ${kind.state.padEnd(10)} ${displaySafe(kind.directory)}`,
    )
  }
}

/**
 * Remove terminal escape sequences and control characters from text a
 * repository controls, keeping `\n` and `\t`. Unlike `displaySafe`, which
 * escapes control characters in a one-line path, this keeps the lines of a
 * multi-line file intact. Whole CSI (`ESC [` or C1 CSI), OSC (`ESC ]`) and
 * two-character ESC sequences go first, so no sequence leaves a tail such as
 * `[31m` behind; then every remaining C0, DEL and C1 character goes.
 */
function stripTerminalControls(text: string): string {
  /* biome-ignore-start lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose of this function */
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  /* biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above */
}

/** True when `target` is `root` or sits under it. */
function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/**
 * Resolve a project config file for printing: its real path when that is
 * inside the checkout root, else the reason it must not be shown. The reason
 * never carries the resolved path, which is outside the repository.
 */
function resolveProjectFileInRepository(
  filePath: string,
  projectRoot: string,
):
  | { readonly kind: 'inside'; readonly realPath: string }
  | { readonly kind: 'withheld'; readonly reason: string } {
  try {
    const realRoot = fs.realpathSync(projectRoot)
    const realPath = fs.realpathSync(filePath)
    return isWithinRoot(realRoot, realPath)
      ? { kind: 'inside', realPath }
      : { kind: 'withheld', reason: 'it resolves outside the repository' }
  } catch {
    return { kind: 'withheld', reason: 'it could not be resolved' }
  }
}

/**
 * Print one config file's text under a heading. The read is the bounded,
 * non-blocking regular-file read the project config uses, so a file that is
 * too large, not a regular file (a directory, a FIFO) or unreadable is a
 * one-line note and the rest of the output still prints. An absent file prints
 * nothing.
 *
 * With `projectRoot` the file is repository-controlled (the project file): its
 * text prints only when its real path is inside that root, and control
 * characters are stripped from it. The user's own files pass no root, so a
 * dotfile symlink to anywhere prints as before.
 */
function printConfigFile(
  heading: string,
  filePath: string,
  projectRoot?: string,
): void {
  let readPath = filePath
  if (projectRoot !== undefined) {
    if (!configEntryExists(filePath)) return
    const contained = resolveProjectFileInRepository(filePath, projectRoot)
    if (contained.kind === 'withheld') {
      console.log(`\n${heading}:`)
      console.log(
        `  ${displaySafe(filePath)} is not shown: ${contained.reason}`,
      )
      return
    }
    // Read the resolved path, so a link swapped in after the check is not followed.
    readPath = contained.realPath
  }
  const read = readTextBounded(readPath, MAX_PROJECT_CONFIG_BYTES)
  if (read.kind === 'absent') return
  console.log(`\n${heading}:`)
  if (read.kind === 'text') {
    console.log(
      projectRoot === undefined
        ? read.content
        : stripTerminalControls(read.content),
    )
    return
  }
  console.log(`  ${displaySafe(filePath)} could not be shown: ${read.reason}`)
}

function configShow(options: { json: boolean }): void {
  if (options.json) {
    const output = buildConfigShowJson()
    console.log(JSON.stringify(output, null, 2))
    if ('error' in output) process.exit(1)
    return
  }

  const paths = getConfigPaths(process.cwd())
  const locations = toJsonLocations(paths)

  console.log('Configuration locations:\n')
  console.log(`  User config:            ${locations.user}`)
  console.log(`  User local config:      ${locations.userLocal}`)
  console.log(`  Project config:         ${locations.project}`)
  if (locations.ignoredProject !== null) {
    console.log(`  Ignored project config: ${locations.ignoredProject}`)
  }
  if (locations.custom !== null) {
    console.log(`  Custom config:          ${locations.custom}`)
  }
  if (locations.customLocal !== null) {
    console.log(`  Custom local config:    ${locations.customLocal}`)
  }

  printConfigFile(
    'Project configuration',
    paths.projectConfig,
    paths.projectRoot,
  )
  printConfigFile('User configuration', paths.userConfig)

  // A failed load exits 1 in both renderings: the same failure must not
  // report success in prose and failure under `--json`. The search section
  // prints either way, because its readers never throw and a failed load is
  // when it helps most.
  const resolved = printResolvedSection()
  printSearchSection(inspectSearchForConfigShow(paths))
  if (!resolved) process.exit(1)
}

function parseConfigShowArgs(rest: string[]): { json: boolean } {
  let json = false
  for (const arg of rest) {
    if (arg === '--json') {
      json = true
    } else {
      console.error(`Unknown argument: ${arg}`)
      console.error(CONFIG_SHOW_USAGE)
      process.exit(1)
    }
  }
  return { json }
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
  switch (a.action) {
    case 'create':
      console.log(`  + ${a.filename}  (create)`)
      break
    case 'update':
      console.log(`  ~ ${a.filename}  (update)`)
      break
    case 'refuse':
      console.log(`  ! ${a.filename}  (refuse: ${a.reason})`)
      break
    case 'remove':
      console.log(`  - ${a.filename}  (remove stale)`)
      break
    case 'skip':
      console.log(`  = ${a.filename}  (up to date)`)
      break
    case 'retain':
      // Edited files are listed in the still-active block, not as action lines.
      break
    default: {
      // A new PlanAction variant must be handled above or this stops compiling.
      const unreachable: never = a
      throw new Error(`Unhandled plan action: ${JSON.stringify(unreachable)}`)
    }
  }
}

/** Owned stale files the user edited: pi-subagents keeps loading them, so each run says so. */
function printStillActive(
  retained: ReadonlyArray<{ filename: string; reason: string }>,
): void {
  if (retained.length === 0) return
  console.log(
    '\nStill active in pi-subagents (edited since export, left in place):',
  )
  for (const r of retained) {
    console.log(`  ! ${r.filename}: ${r.reason}`)
  }
  console.log(
    '  Revert each file to its exported content or delete it, then run this command again to finish.',
  )
}

function retainedFromPlan(
  plan: ReturnType<typeof preview>,
): Array<{ filename: string; reason: string }> {
  return plan.actions.flatMap((a) =>
    a.action === 'retain' ? [{ filename: a.filename, reason: a.reason }] : [],
  )
}

function summarizePlan(plan: ReturnType<typeof preview>): void {
  const counts = {
    create: 0,
    update: 0,
    refuse: 0,
    remove: 0,
    skip: 0,
    retain: 0,
  }
  for (const a of plan.actions) {
    counts[a.action]++
    printActionLine(a)
  }
  console.log('')
  console.log(
    `Summary: ${counts.create} create, ${counts.update} update, ` +
      `${counts.skip} skip, ${counts.refuse} refuse, ${counts.remove} remove, ` +
      `${counts.retain} still active`,
  )
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
  summarizePlan(plan)
  printStillActive(retainedFromPlan(plan))
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
    summarizePlan(plan)
  }
  if (!hasWork) {
    const stillActive = retainedFromPlan(plan)
    // Edited files still need reporting, so only a run with nothing to report says "No changes".
    if (stillActive.length === 0) {
      console.log('All persona files are already up to date. No changes.')
    }
    printStillActive(stillActive)
    return
  }
  const result = exportPersonas(agentsRoot, configOptions)
  if (result.status === 'error') {
    console.error(`Export failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const hadRemovals = plan.actions.some((a) => a.action === 'remove')
  if (
    result.written === 0 &&
    result.refused.length === 0 &&
    result.retained.length === 0 &&
    !hadRemovals
  ) {
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
  printStillActive(result.retained)
}

function runRefresh(agentsRoot: string, scope: 'project' | 'global'): void {
  const result = refresh(agentsRoot, { scope, cwd: process.cwd() })
  if (result.status === 'error') {
    console.error(`Refresh failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const changed =
    result.updated + result.removed.length + result.retained.length > 0
  if (!changed) {
    console.log('All owned persona files are up to date. No changes.')
  }
  if (result.updated > 0) {
    console.log(
      `Refreshed: updated ${result.updated} file(s) in ${agentsRoot}/.`,
    )
  }
  if (result.removed.length > 0) {
    console.log(
      `Removed ${result.removed.length} file(s) from ${agentsRoot}/ (persona disabled or no longer exported):`,
    )
    for (const r of result.removed) console.log(`  - ${r.filename}`)
  }
  if (result.skippedUnowned > 0)
    console.log(
      `  Skipped ${result.skippedUnowned} unowned file(s) (not touched).`,
    )
  printStillActive(result.retained)
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
    case 'search':
      // Set the exit code instead of calling process.exit, so buffered stdout
      // is never cut off.
      void runSearchCli({
        argv: args.slice(1),
        cwd: process.cwd(),
        errorSink: console.error,
        usageName: 'systematic search',
        ...searchCliInputs(),
        outputSink: console.log,
      }).then((status) => {
        process.exitCode = status
      })
      break
    case 'validate-review-return': {
      const status = runValidateReviewReturnCli({
        argv: ['systematic', ...args],
        errorSink: console.error,
        isTTY: process.stdin.isTTY === true,
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
          configShow(parseConfigShowArgs(args.slice(2)))
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

if (isMainModule(import.meta.url)) {
  runLegacyCli(process.argv.slice(2))
}
