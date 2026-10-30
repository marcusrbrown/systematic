// Pi coding-agent extension entry point (built to dist/pi.js via pi.extensions manifest).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { buildAgentCatalog } from './lib/agent-resolver.js'
import {
  composeSystemPromptWithBootstrap,
  computeBootstrapContentSafe,
  readHarnessProfile,
  readWorktreePlacementRule,
} from './lib/bootstrap.js'
import type { SourcedOverlayConfigMap, SystematicConfig } from './lib/config.js'
import { isAgentDisabled, loadConfigWithSources } from './lib/config.js'
import { createRealPiDelegateSession } from './lib/pi-delegate-session.js'
import { createPiDelegateTool } from './lib/pi-delegate-tool.js'
import {
  CURATED_PERSONAS,
  parseSourceCategoryAndKey,
} from './lib/pi-subagents-personas.js'
import { createPiSearchTool, isSearchEnabled } from './lib/search-tool.js'
import {
  buildSkillContentOutput,
  buildSkillToolDescription,
  buildSkillToolParameterHint,
  resolveSkill,
} from './lib/skill-resolver.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const bundledSkillsDir = path.join(packageRoot, 'skills')
const bundledAgentsDir = path.join(packageRoot, 'agents')
const PI_BOOTSTRAP_USAGE_TEMPLATE = `**Skills usage:**
- Use \`systematic_skill\` for Systematic skills.
- For non-Systematic skills, follow Pi's native skill instructions and read the listed SKILL.md path.`

const reportPiBootstrapFailure = (): void => {
  process.stderr.write(
    '[systematic] Failed to compute Pi bootstrap; continuing without injection.\n',
  )
}

const reportPiDelegateCatalogFailure = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `[systematic] Failed to build Pi agent catalog; systematic_delegate will not be registered: ${message}\n`,
  )
}

const PACKAGED_OVERLAY_WARNING =
  '[systematic] systematic.json configures agent or pi_subagents overlays (model, thinking, max_turns, tools or skills). ' +
  "Personas packaged with Systematic ignore overlays; they load with pi-subagents' defaults. " +
  'Run `systematic pi-subagents export` to write overlay-aware persona files, which outrank the packaged ones.\n'

const reportPackagedOverlayIgnored = (): void => {
  process.stderr.write(PACKAGED_OVERLAY_WARNING)
}

const reportPackagedPersonasStillLoad = (count: number): void => {
  process.stderr.write(
    `[systematic] ${count} persona(s) disabled in systematic.json still load in pi-subagents from the Systematic package, ` +
      'which has no access to that setting. ' +
      'To stop them loading, disable one with /agents → Disable, or set `packageAgents: false` in subagents.json to turn off every packaged persona. ' +
      "This notice repeats on each start while the setting is present, because Systematic cannot read pi-subagents' own settings.\n",
  )
}

/**
 * The warnings print once per process. A pi-subagents child session loads the
 * extension again, possibly from a fresh module instance, so the flag lives on
 * `globalThis` under a registered symbol.
 */
const WARNINGS_EMITTED_KEY = Symbol.for('systematic.pi.packagedWarningsEmitted')

function claimPackagedWarnings(): boolean {
  if (Reflect.get(globalThis, WARNINGS_EMITTED_KEY) === true) return false
  Reflect.set(globalThis, WARNINGS_EMITTED_KEY, true)
  return true
}

/**
 * Routing fields the Pi export reads: `model` and the `pi` block. Overlay
 * fields only OpenCode consumes (`temperature`, `hidden`, `color`, ...) change
 * no exported file, so they are not worth a warning.
 */
const PI_CONSUMED_ROUTING_FIELDS = ['model', 'pi'] as const

function hasPiConsumedRoutingField(
  overlays: Record<string, { value: object }>,
): boolean {
  return Object.values(overlays).some(({ value }) =>
    PI_CONSUMED_ROUTING_FIELDS.some((field) => Object.hasOwn(value, field)),
  )
}

/** Whether any overlay would change an exported persona: routing overlays or any pi_subagents entry. */
function hasOverlaysPackagedPersonasIgnore(
  routing: SourcedOverlayConfigMap,
  piSubagents: SystematicConfig['pi_subagents'],
): boolean {
  return (
    hasPiConsumedRoutingField(routing.agents) ||
    hasPiConsumedRoutingField(routing.categories) ||
    hasNonEmptyEntry(piSubagents?.agents) ||
    hasNonEmptyEntry(piSubagents?.categories)
  )
}

/** Project config can leave an entry's key behind after trust strips every field; that entry changes nothing. */
function hasNonEmptyEntry(
  entries: Record<string, object> | undefined,
): boolean {
  return Object.values(entries ?? {}).some(
    (entry) => Object.keys(entry).length > 0,
  )
}

/** How many curated personas the user's disable settings turn off for `systematic_delegate` and the export. */
function countDisabledPackagedPersonas(
  config: SystematicConfig,
  routing: SourcedOverlayConfigMap,
): number {
  const disabledAgents = new Set(config.disabled_agents)
  return CURATED_PERSONAS.filter((persona) => {
    const { category, agentKey } = parseSourceCategoryAndKey(persona.relPath)
    return isAgentDisabled(
      disabledAgents,
      routing.agents,
      category ?? '',
      agentKey,
    )
  }).length
}

type PiExtensionDependencies = {
  buildAgentCatalog?: typeof buildAgentCatalog
}

const defaultPiExtensionDependencies = {
  buildAgentCatalog,
} satisfies PiExtensionDependencies

export default async function systematicPiExtension(
  pi: ExtensionAPI,
  deps: PiExtensionDependencies = defaultPiExtensionDependencies,
): Promise<void> {
  const { buildAgentCatalog: buildAgentCatalogFn = buildAgentCatalog } = deps

  // Loaded once at extension init, same as OpenCode's `loadConfig(directory)`
  // call in src/index.ts — not wrapped in try/catch, so an invalid config
  // fails the whole extension init the same way it fails OpenCode's plugin
  // init (fail hard, not fail open). `process.cwd()` mirrors OpenCode's
  // `directory` (both resolve to the process's working directory; there is
  // no per-dispatch cwd available at extension init time). A profile change
  // needs a Pi restart to take effect (KTD: "no per-dispatch re-parse").
  const {
    config: piConfig,
    metadata: piConfigMetadata,
    overlays: piRoutingOverlays,
  } = loadConfigWithSources(process.cwd())

  // Packaged personas load straight from the package and never see config, so
  // say once at init when a setting could not reach them. The warnings name no
  // config values; they neither detect pi-subagents nor touch the filesystem.
  const overlaysIgnored = hasOverlaysPackagedPersonasIgnore(
    piRoutingOverlays,
    piConfig.pi_subagents,
  )
  const disabledPackaged = countDisabledPackagedPersonas(
    piConfig,
    piRoutingOverlays,
  )
  if ((overlaysIgnored || disabledPackaged > 0) && claimPackagedWarnings()) {
    if (overlaysIgnored) reportPackagedOverlayIgnored()
    if (disabledPackaged > 0) reportPackagedPersonasStillLoad(disabledPackaged)
  }

  // Honors `disabled_skills` the same way OpenCode's `src/index.ts` does. Pi's
  // native `pi.skills` discovery is a separate path and is not filtered.
  const resolverOptions = {
    bundledSkillsDir,
    disabledSkills: piConfig.disabled_skills,
  }

  // Match OpenCode's process-lifetime bootstrap snapshot.
  const bootstrapContent = computeBootstrapContentSafe(
    {
      bundledSkillsDir,
      usageTemplate: PI_BOOTSTRAP_USAGE_TEMPLATE,
      // Always supplied; the bootstrap omits it when git-worktree is disabled.
      worktreePlacementRule:
        readWorktreePlacementRule(bundledSkillsDir) ?? undefined,
      // Profile files owned by skills/using-systematic/references/ — Unit 2 of 2026-07-16-001 plan.
      profileBlock: readHarnessProfile(bundledSkillsDir, 'pi') ?? undefined,
    },
    reportPiBootstrapFailure,
    // Only `disabled_skills` reaches the bootstrap: Pi keeps ignoring
    // `bootstrap.enabled` and `bootstrap.file`.
    piConfig.disabled_skills,
  )

  pi.on(
    'before_agent_start',
    (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | undefined => {
      const systemPrompt = composeSystemPromptWithBootstrap(
        event.systemPrompt,
        bootstrapContent,
      )
      if (systemPrompt === null) return undefined
      return { systemPrompt }
    },
  )

  pi.registerTool({
    name: 'systematic_skill',
    label: 'Systematic Skill',
    description: buildSkillToolDescription(resolverOptions),
    promptSnippet: 'Use `systematic_skill` to load Systematic skills.',
    parameters: Type.Object({
      name: Type.String({
        description: buildSkillToolParameterHint(resolverOptions),
      }),
    }),
    async execute(_toolCallId, params) {
      const matchedSkill = resolveSkill(resolverOptions, params.name)
      const { output, dir } = buildSkillContentOutput(matchedSkill)

      return {
        content: [{ type: 'text', text: output }],
        details: { skillDir: dir },
      }
    },
  })

  // One definition serves the parent session and every delegate. Absent when
  // `search.enabled` is false, which leaves a delegate's allowlist entry inert.
  const searchTool = isSearchEnabled(piConfig.search)
    ? createPiSearchTool({
        settings: piConfig.search,
        unreadable: piConfig.searchUnreadable,
        Type,
      })
    : undefined
  if (searchTool !== undefined) pi.registerTool(searchTool)

  try {
    // Filtered after building so `buildAgentCatalog` keeps checking the full
    // inventory for duplicate names; one filter covers the tool's description,
    // hint, lookup and unknown-persona error.
    const disabledAgents = new Set(piConfig.disabled_agents)
    const catalog = buildAgentCatalogFn(bundledAgentsDir).filter(
      (entry) =>
        !isAgentDisabled(
          disabledAgents,
          piRoutingOverlays.agents,
          entry.category,
          entry.key,
        ),
    )
    pi.registerTool(
      createPiDelegateTool({
        catalog,
        createDelegateSession: createRealPiDelegateSession,
        overlays: piRoutingOverlays,
        piSubagentsOverlays: piConfig.pi_subagents,
        activeProfile: piConfigMetadata.activeProfile,
        ...(searchTool !== undefined && { customTools: [searchTool] }),
      }),
    )
  } catch (error) {
    reportPiDelegateCatalogFailure(error)
  }
}
