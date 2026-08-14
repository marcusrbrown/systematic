import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser'
import type { z } from 'zod'
import {
  BUNDLED_AGENT_NAMES,
  BUNDLED_AGENT_QUALIFIED_IDS,
  BUNDLED_SKILL_NAMES,
} from './bundled-names.js'
import {
  PI_SUBAGENTS_PROTECTED_FIELDS,
  SECURITY_OVERLAY_FIELDS,
  SystematicConfigSchema,
} from './config-schema.js'
import { REMOVED_BUNDLED_AGENT_CATEGORIES } from './removed-names.js'

export interface BootstrapConfig {
  enabled: boolean
  file?: string
}

export type WorkflowGuardMode = 'observe' | 'protected' | 'disabled'

export interface WorkflowGuardConfig {
  mode: WorkflowGuardMode
  debug: boolean
}

export type OverlayConfig = Record<string, unknown>

export type OverlayConfigMap = Record<string, OverlayConfig>

export interface SourcedOverlayConfig {
  value: OverlayConfig
  sourcePath: string
  keyPath: string
}

export interface SourcedOverlayConfigMap {
  agents: Record<string, SourcedOverlayConfig>
  categories: Record<string, SourcedOverlayConfig>
}

export const CONFIG_AUTHORITY_FIELD_PATHS = [
  'bootstrap.enabled',
  'bootstrap.file',
  'skills_as_commands',
  'workflow_guard.debug',
  'workflow_guard.mode',
] as const

export const CONFIG_PROTECTED_FIELD_PATHS = [
  'workflow_guard',
  'agents.*.model',
  'agents.*.permission',
  'agents.*.skills',
  'agents.*.variant',
  'categories.*.model',
  'categories.*.permission',
  'categories.*.skills',
  'categories.*.variant',
] as const

export type ConfigSourceKind = 'custom' | 'project' | 'user'
export type ConfigSourcePresence = 'absent' | 'invalid' | 'present'
export type ConfigSourceErrorCode =
  | 'parse-failed'
  | 'read-failed'
  | 'schema-invalid'
  | 'source-invalid'
export type ConfigAuthorityFieldPath =
  (typeof CONFIG_AUTHORITY_FIELD_PATHS)[number]
export type ConfigProtectedFieldPath =
  (typeof CONFIG_PROTECTED_FIELD_PATHS)[number]

export interface ConfigSourceMetadata {
  readonly errorCode?: ConfigSourceErrorCode
  readonly kind: ConfigSourceKind
  readonly presence: ConfigSourcePresence
}

export interface ConfigAuthorityMetadata {
  readonly fieldPath: ConfigAuthorityFieldPath
  readonly sourceKind: ConfigSourceKind
}

export interface ConfigProtectedFieldMetadata {
  readonly fieldPath: ConfigProtectedFieldPath
  readonly outcome: 'blocked'
  readonly sourceKind: ConfigSourceKind
}

export interface ConfigObservationMetadata {
  readonly authorities: readonly ConfigAuthorityMetadata[]
  readonly protectedFields: readonly ConfigProtectedFieldMetadata[]
  readonly sources: readonly ConfigSourceMetadata[]
}

export interface SourceAwareConfigResult {
  config: SystematicConfig
  metadata: ConfigObservationMetadata
  overlays: SourcedOverlayConfigMap
}

export interface PiSubagentsOverlayMap {
  categories?: OverlayConfigMap
  agents?: OverlayConfigMap
}

export interface SystematicConfig {
  disabled_skills: string[]
  disabled_agents: string[]
  disabled_commands: string[]
  bootstrap: BootstrapConfig
  workflow_guard: WorkflowGuardConfig
  agents?: OverlayConfigMap
  categories?: OverlayConfigMap
  pi_subagents?: PiSubagentsOverlayMap
  skills_as_commands: boolean
}

export const DEFAULT_CONFIG: SystematicConfig = {
  disabled_skills: [],
  disabled_agents: [],
  disabled_commands: [],
  bootstrap: {
    enabled: true,
  },
  workflow_guard: {
    mode: 'observe',
    debug: false,
  },
  agents: {},
  categories: {},
  pi_subagents: { categories: {}, agents: {} },
  skills_as_commands: true,
}

interface RawWorkflowGuardConfig {
  mode?: WorkflowGuardMode
  debug?: boolean
}

interface RawSystematicConfig
  extends Omit<
    Partial<SystematicConfig>,
    'agents' | 'categories' | 'pi_subagents' | 'workflow_guard'
  > {
  agents?: unknown
  categories?: unknown
  pi_subagents?: { categories?: unknown; agents?: unknown }
  workflow_guard?: RawWorkflowGuardConfig
}

interface ConfigSource {
  canonicalPath: string
  path: string
  config: RawSystematicConfig
  protectedFields: readonly ConfigProtectedFieldMetadata[]
  trust: ConfigSourceKind
}

type SecurityOverlayField = (typeof SECURITY_OVERLAY_FIELDS)[number]

const PROTECTED_OVERLAY_FIELD_PATHS = {
  agents: {
    model: 'agents.*.model',
    permission: 'agents.*.permission',
    skills: 'agents.*.skills',
    variant: 'agents.*.variant',
  },
  categories: {
    model: 'categories.*.model',
    permission: 'categories.*.permission',
    skills: 'categories.*.skills',
    variant: 'categories.*.variant',
  },
} satisfies Record<
  'agents' | 'categories',
  Record<SecurityOverlayField, ConfigProtectedFieldPath>
>

const PROJECT_PROTECTED_FIELDS = new Set(['workflow_guard'])

/**
 * The set of currently-bundled skill names. Used to identify removed names
 * that parsed successfully (because they are in the removed-names list) but
 * are no longer active and must be dropped from the effective config.
 */
const CURRENT_SKILL_NAMES_SET: ReadonlySet<string> = new Set(
  BUNDLED_SKILL_NAMES,
)

/**
 * The set of currently-bundled agent names (bare and qualified). Used to
 * identify removed names that parsed successfully but are no longer active.
 */
const CURRENT_AGENT_NAMES_SET: ReadonlySet<string> = new Set([
  ...BUNDLED_AGENT_NAMES,
  ...BUNDLED_AGENT_QUALIFIED_IDS,
])

const REMOVED_AGENT_CATEGORIES_SET: ReadonlySet<string> = new Set(
  REMOVED_BUNDLED_AGENT_CATEGORIES,
)

/**
 * Return the subset of `names` that are absent from `allowedSet`. These are
 * names that parsed successfully (they are in the removed-names list so the
 * schema accepted them) but are no longer active bundled names and must be
 * dropped from the effective config.
 */
export function computeDroppedNames(
  names: readonly string[],
  allowedSet: ReadonlySet<string>,
): string[] {
  return names.filter((n) => !allowedSet.has(n))
}

const MIGRATION_DOCS_URL = 'https://fro.bot/systematic/guides/v3-migration/'

/**
 * Emit a `[systematic]` warning for each dropped name that has not already
 * been warned about in this load invocation. The `warned` set is local to a
 * single load call -- callers must NOT share it across independent loads.
 * Passing a fresh set per load ensures no cross-load suppression.
 */
export function warnDroppedNames(
  dropped: string[],
  field: string,
  warned: Set<string>,
  removalVersion?: string,
  warningSink: (message: string) => void = console.warn,
): void {
  for (const name of dropped) {
    if (warned.has(name)) continue
    warned.add(name)
    const displayName = field === 'categories' ? `${field}.${name}` : name
    const removalNote = removalVersion
      ? ` It was removed in ${removalVersion}.`
      : ''
    warningSink(
      `[systematic] "${displayName}" in \`${field}\` is no longer a bundled name and will be ignored.${removalNote} Remove it from your config to silence this warning. See ${MIGRATION_DOCS_URL} for migration guidance.`,
    )
  }
}

/**
 * Resolve a config file path by checking `.jsonc` first, then `.json`.
 * Returns the first existing file, or the `.json` path as fallback so
 * callers that `fs.existsSync` the result still work.
 */
function resolveConfigPath(dir: string, basename: string): string {
  const jsoncPath = path.join(dir, `${basename}.jsonc`)
  if (fs.existsSync(jsoncPath)) return jsoncPath
  return path.join(dir, `${basename}.json`)
}

function isErrorWithCode(error: unknown): error is Error & { code?: unknown } {
  return error instanceof Error && 'code' in error
}

function loadJsoncFile(filePath: string): RawSystematicConfig | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') return null
    throw new Error(
      `Invalid Systematic config in ${filePath}: unable to read file`,
      { cause: error },
    )
  }

  const errors: ParseError[] = []
  const parsed = parseJsonc(content, errors) as unknown
  if (errors.length > 0) {
    const error = errors[0]
    const message = error
      ? `${printParseErrorCode(error.error)} at offset ${error.offset}`
      : 'unknown parse error'
    throw new Error(
      `Invalid Systematic config in ${filePath}: JSONC parse error: ${message}`,
    )
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Invalid Systematic config in ${filePath}: root must be an object`,
    )
  }

  return parsed as RawSystematicConfig
}

/**
 * Documentation URL for the full list of valid bundled agent and skill names.
 * Appended to unrecognized-key error messages so users can self-serve without
 * having to dump all 100+ names inline in the error.
 */
const TYPED_VALIDATION_DOCS_URL =
  'https://fro.bot/systematic/reference/configuration#typed-validation'

/**
 * Fields in the top-level config where an unrecognized key means a typo'd
 * bundled name. For these paths we append the docs URL to the error message.
 */
const TYPED_KEY_FIELDS = new Set([
  'agents',
  'disabled_agents',
  'disabled_skills',
])

/**
 * Format the human-readable hint for unrecognized-key issues. Requires a
 * non-empty `badKeys` array — Zod 4's $ZodIssueUnrecognizedKeys carries at
 * least one key by construction, so the empty case is unreachable in practice.
 */
function formatUnrecognizedKeysHint(
  badKeys: readonly string[],
  topField: string,
): string {
  if (badKeys.length === 0) {
    // Defensive: Zod 4's $ZodIssueUnrecognizedKeys always carries non-empty
    // keys; this branch is unreachable under the current Zod 4 contract.
    throw new Error('formatUnrecognizedKeysHint requires non-empty keys')
  }
  if (badKeys.length === 1) {
    return `Unrecognized key '${badKeys[0]}' in \`${topField}\`. This must be a bundled name. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
  }
  const joined = badKeys.map((k) => `'${k}'`).join(', ')
  return `Unrecognized keys ${joined} in \`${topField}\`. These must be bundled names. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
}

/**
 * Post-process Zod issues to enrich unrecognized-key errors on typed fields
 * (agents, disabled_agents, disabled_skills) with a pointer to the docs URL
 * where the full list of valid bundled names is published.
 *
 * Also suppresses the verbose enum list that Zod emits for invalid_value
 * issues on disabled_agents and disabled_skills, replacing it with a short
 * hint that surfaces the bad value and points at the docs URL.
 *
 * Returns the issues array unchanged when no enrichment is needed.
 */
function enrichUnrecognizedKeyIssues(
  issues: readonly z.core.$ZodIssue[],
  rawInput: unknown,
): readonly z.core.$ZodIssue[] {
  return issues.map((issue) => {
    const topField = issue.path[0]
    if (typeof topField !== 'string' || !TYPED_KEY_FIELDS.has(topField)) {
      return issue
    }

    // Handle unrecognized_keys (typo'd agents overlay keys).
    // Use issue.keys (Zod 4 structured field) — avoids regex and handles any key value.
    if (issue.code === 'unrecognized_keys') {
      const hint = formatUnrecognizedKeysHint(issue.keys, topField)
      return { ...issue, message: hint }
    }

    // Handle invalid_value (typo'd disabled_agents / disabled_skills entries) —
    // suppress the verbose enum list Zod emits by default.
    // Zod 4's $ZodIssueInvalidValue does not carry the bad value in the issue
    // object itself, so we resolve it from the raw input via the issue path.
    if (
      issue.code === 'invalid_value' &&
      (topField === 'disabled_agents' || topField === 'disabled_skills')
    ) {
      const badValue = resolveValueAtPath(rawInput, issue.path)
      const kind = topField === 'disabled_agents' ? 'agent' : 'skill'
      const hint =
        typeof badValue === 'string'
          ? `Unrecognized ${kind} name '${badValue}' in \`${topField}\`. This must be a bundled name. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
          : `Invalid value in \`${topField}\`. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
      return { ...issue, message: hint }
    }

    return issue
  })
}

/**
 * Walk a path of string/number keys into a nested object/array structure and
 * return the value at that location, or undefined if any step is missing.
 */
function resolveValueAtPath(
  root: unknown,
  path: readonly (string | number | symbol)[],
): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (typeof segment === 'symbol') {
      // Defensive: Zod 4's path type includes symbol, but issues never carry
      // symbol segments at runtime. If a future Zod release changes that, this
      // returns undefined so the fallback "Invalid value" hint is used instead
      // of crashing.
      return undefined
    }
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (!isRecord(current)) return undefined
      current = current[segment]
    }
  }
  return current
}

function throwTopLevelConfigSchemaError(
  filePath: string,
  trust: ConfigSource['trust'],
  rawIssues: readonly z.core.$ZodIssue[],
  rawInput: unknown,
): never {
  const issues = enrichUnrecognizedKeyIssues(rawIssues, rawInput)
  // Defensive fallback. Zod 4 invariant: safeParse never returns success: false with an
  // empty issues array, but enrichUnrecognizedKeyIssues is a pure transform and could in
  // principle yield zero entries from a future Zod that emits issues we filter out.
  if (issues.length === 0) {
    throw Object.assign(
      new Error(
        `Invalid Systematic config in ${filePath}: schema validation failed`,
      ),
      { _tag: 'ConfigSchemaError' as const, filePath, trust, issues },
    )
  }
  const formatIssue = (issue: z.core.$ZodIssue): string => {
    const fieldPath =
      issue.code === 'unrecognized_keys' ? null : issue.path.join('.')
    return fieldPath ? `${fieldPath} ${issue.message}` : issue.message
  }
  const formatted = issues.map(formatIssue)
  // Single-issue case keeps the one-line shape for backward compatibility with existing
  // user expectations. Multi-issue case uses a bullet list so every problem surfaces.
  const message =
    formatted.length === 1
      ? `Invalid Systematic config in ${filePath}: ${formatted[0]}`
      : `Invalid Systematic config in ${filePath}:\n${formatted.map((entry) => `  - ${entry}`).join('\n')}`
  throw Object.assign(new Error(message), {
    _tag: 'ConfigSchemaError' as const,
    filePath,
    trust,
    issues,
  })
}

function loadConfigSource(
  filePath: string,
  trust: ConfigSource['trust'],
  invalidSource: 'throw' | 'report',
): { metadata: ConfigSourceMetadata; source: ConfigSource | null } {
  try {
    const rawConfig = loadJsoncFile(filePath)
    if (!rawConfig) {
      return {
        metadata: { kind: trust, presence: 'absent' },
        source: null,
      }
    }

    const protectedFields = collectProjectProtectedFields(rawConfig, trust)
    const config =
      trust === 'project' ? stripProjectProtectedFields(rawConfig) : rawConfig

    const result = SystematicConfigSchema.safeParse(config)
    if (!result.success) {
      throwTopLevelConfigSchemaError(
        filePath,
        trust,
        result.error.issues,
        config,
      )
    }

    // Validation succeeded; propagate raw parsed JSONC so the merge layer
    // sees undefined for unset fields (preserves merge semantics where a
    // higher-priority empty config does NOT override a lower-priority explicit
    // setting). The schema's defaults are applied by the merge layer via
    // DEFAULT_CONFIG at the top of the spread chain.
    return {
      metadata: { kind: trust, presence: 'present' },
      source: {
        canonicalPath: resolveConfigSourcePath(filePath),
        config,
        path: filePath,
        protectedFields,
        trust,
      },
    }
  } catch (error) {
    if (invalidSource === 'throw') throw error
    return {
      metadata: {
        errorCode: classifyConfigSourceError(error),
        kind: trust,
        presence: 'invalid',
      },
      source: null,
    }
  }
}

function classifyConfigSourceError(error: unknown): ConfigSourceErrorCode {
  if (isConfigSchemaError(error)) return 'schema-invalid'
  if (!(error instanceof Error)) return 'source-invalid'
  if (error.message.includes('JSONC parse error')) return 'parse-failed'
  if (error.message.includes('unable to read file')) return 'read-failed'
  return 'source-invalid'
}

function isConfigSchemaError(
  error: unknown,
): error is Error & { readonly _tag: 'ConfigSchemaError' } {
  return isRecord(error) && error._tag === 'ConfigSchemaError'
}

function resolveConfigSourcePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function collectProjectProtectedFields(
  rawConfig: RawSystematicConfig,
  trust: ConfigSource['trust'],
): readonly ConfigProtectedFieldMetadata[] {
  if (trust !== 'project') return []

  return [
    ...(Object.hasOwn(rawConfig, 'workflow_guard')
      ? [
          {
            fieldPath: 'workflow_guard' as const,
            outcome: 'blocked' as const,
            sourceKind: 'project' as const,
          },
        ]
      : []),
    ...collectOverlayProtectedFields(rawConfig.agents, 'agents'),
    ...collectOverlayProtectedFields(rawConfig.categories, 'categories'),
  ]
}

function collectOverlayProtectedFields(
  overlayMap: unknown,
  mapKey: 'agents' | 'categories',
): readonly ConfigProtectedFieldMetadata[] {
  if (!isRecord(overlayMap)) return []
  return Object.values(overlayMap).flatMap((value) =>
    isRecord(value) ? collectProtectedOverlayValue(value, mapKey) : [],
  )
}

function collectProtectedOverlayValue(
  value: Record<string, unknown>,
  mapKey: 'agents' | 'categories',
): readonly ConfigProtectedFieldMetadata[] {
  return [...SECURITY_OVERLAY_FIELDS]
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => ({
      fieldPath: PROTECTED_OVERLAY_FIELD_PATHS[mapKey][field],
      outcome: 'blocked' as const,
      sourceKind: 'project' as const,
    }))
}

function stripProjectProtectedFields(
  rawConfig: RawSystematicConfig,
): RawSystematicConfig {
  const config = { ...rawConfig }
  for (const field of PROJECT_PROTECTED_FIELDS) {
    delete (config as Record<string, unknown>)[field]
  }
  return config
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeArraysUnique<T>(
  arr1: T[] | undefined,
  arr2: T[] | undefined,
): T[] {
  const set = new Set<T>()
  if (arr1) for (const item of arr1) set.add(item)
  if (arr2) for (const item of arr2) set.add(item)
  return Array.from(set)
}

export interface LoadConfigOptions {
  /**
   * When false, the project-level config source (`<cwd>/.opencode/systematic.json`)
   * is not loaded at all — not merged, not trust-stripped, entirely absent from
   * the source chain. Used by global-scoped pi-subagents export so it never
   * absorbs cwd project overlays (plan R7/R19). Defaults to true.
   */
  includeProject?: boolean
  invalidSource?: 'throw' | 'report'
  homeDir?: string
  userConfigDir?: string
  customConfigDir?: string | null
  warningSink?: (message: string) => void
}

export function loadConfig(
  projectDir: string,
  options?: LoadConfigOptions,
): SystematicConfig {
  return loadConfigWithSources(projectDir, options).config
}

export function loadConfigWithSources(
  projectDir: string,
  options?: LoadConfigOptions,
): SourceAwareConfigResult {
  const includeProject = options?.includeProject ?? true
  const invalidSource = options?.invalidSource ?? 'throw'
  const paths = getConfigPaths(projectDir, options)
  const warningSink = options?.warningSink ?? console.warn

  const user = loadConfigSource(paths.userConfig, 'user', invalidSource)
  const project = includeProject
    ? loadConfigSource(paths.projectConfig, 'project', invalidSource)
    : {
        metadata: { kind: 'project' as const, presence: 'absent' as const },
        source: null,
      }
  const custom = paths.customConfig
    ? loadConfigSource(paths.customConfig, 'custom', invalidSource)
    : {
        metadata: { kind: 'custom' as const, presence: 'absent' as const },
        source: null,
      }
  const userSource = user.source
  const projectSource = project.source
  const customSource = custom.source
  const sources = [userSource, projectSource, customSource].filter(
    (source): source is ConfigSource => source !== null,
  )

  const mergedOverlays = mergeOverlaySources(sources)
  const mergedPiSubagentsOverlays = mergePiSubagentsOverlaySources(sources)
  const droppedCategories = Object.keys(mergedOverlays.categories).filter(
    (name) => REMOVED_AGENT_CATEGORIES_SET.has(name),
  )
  const warned = new Set<string>()
  warnDroppedNames(
    droppedCategories,
    'categories',
    warned,
    'v3.0.0',
    warningSink,
  )
  const droppedCategorySet = new Set(droppedCategories)
  const overlays: SourcedOverlayConfigMap =
    droppedCategorySet.size === 0
      ? mergedOverlays
      : {
          ...mergedOverlays,
          categories: Object.fromEntries(
            Object.entries(mergedOverlays.categories).filter(
              ([key]) => !droppedCategorySet.has(key),
            ),
          ),
        }
  const userConfig = userSource?.config
  const projectConfig = projectSource?.config
  const customConfig = customSource?.config

  const result: SystematicConfig = {
    disabled_skills: mergeArraysUnique(
      mergeArraysUnique(
        mergeArraysUnique(
          DEFAULT_CONFIG.disabled_skills,
          userConfig?.disabled_skills,
        ),
        projectConfig?.disabled_skills,
      ),
      customConfig?.disabled_skills,
    ),
    disabled_agents: mergeArraysUnique(
      mergeArraysUnique(
        mergeArraysUnique(
          DEFAULT_CONFIG.disabled_agents,
          userConfig?.disabled_agents,
        ),
        projectConfig?.disabled_agents,
      ),
      customConfig?.disabled_agents,
    ),
    disabled_commands: mergeArraysUnique(
      mergeArraysUnique(
        mergeArraysUnique(
          DEFAULT_CONFIG.disabled_commands,
          userConfig?.disabled_commands,
        ),
        projectConfig?.disabled_commands,
      ),
      customConfig?.disabled_commands,
    ),
    bootstrap: {
      ...DEFAULT_CONFIG.bootstrap,
      ...userConfig?.bootstrap,
      ...projectConfig?.bootstrap,
      ...customConfig?.bootstrap,
    },
    workflow_guard: {
      ...DEFAULT_CONFIG.workflow_guard,
      ...userConfig?.workflow_guard,
      ...customConfig?.workflow_guard,
    },
    agents: overlayValues(overlays.agents),
    categories: overlayValues(overlays.categories),
    pi_subagents: {
      categories: overlayValues(mergedPiSubagentsOverlays.categories),
      agents: overlayValues(mergedPiSubagentsOverlays.agents),
    },
    skills_as_commands:
      customConfig?.skills_as_commands ??
      projectConfig?.skills_as_commands ??
      userConfig?.skills_as_commands ??
      DEFAULT_CONFIG.skills_as_commands,
  }

  // Drop removed names from the effective config and warn about each one.
  // This runs on the merged output, not on the raw config objects, so merge
  // precedence and raw-config preservation are both unaffected. A local Set
  // deduplicates warnings within this single load invocation without any
  // sticky module-global state that could suppress unrelated later warnings.
  const droppedSkills = computeDroppedNames(
    result.disabled_skills,
    CURRENT_SKILL_NAMES_SET,
  )
  warnDroppedNames(
    droppedSkills,
    'disabled_skills',
    warned,
    undefined,
    warningSink,
  )

  const droppedAgents = computeDroppedNames(
    result.disabled_agents,
    CURRENT_AGENT_NAMES_SET,
  )
  warnDroppedNames(
    droppedAgents,
    'disabled_agents',
    warned,
    undefined,
    warningSink,
  )

  const droppedSkillSet = new Set(droppedSkills)
  const droppedAgentSet = new Set(droppedAgents)

  const effectiveConfig: SystematicConfig =
    droppedSkillSet.size === 0 && droppedAgentSet.size === 0
      ? result
      : {
          ...result,
          disabled_skills: result.disabled_skills.filter(
            (n) => !droppedSkillSet.has(n),
          ),
          disabled_agents: result.disabled_agents.filter(
            (n) => !droppedAgentSet.has(n),
          ),
        }

  return {
    config: effectiveConfig,
    metadata: buildConfigObservationMetadata({
      custom: custom.metadata,
      project: project.metadata,
      sources,
      user: user.metadata,
    }),
    overlays,
  }
}

interface ConfigSourceLoadSummary {
  readonly custom: ConfigSourceMetadata
  readonly project: ConfigSourceMetadata
  readonly sources: readonly ConfigSource[]
  readonly user: ConfigSourceMetadata
}

function buildConfigObservationMetadata(
  summary: ConfigSourceLoadSummary,
): ConfigObservationMetadata {
  const authorities: ConfigAuthorityMetadata[] = []
  const sourceConfigs = new Map<ConfigSourceKind, RawSystematicConfig>()
  const sourcePaths = new Map<ConfigSourceKind, string>()
  for (const source of summary.sources) {
    sourceConfigs.set(source.trust, source.config)
    sourcePaths.set(source.trust, source.canonicalPath)
  }

  const firstDefinedSource = (
    fieldPath: ConfigAuthorityFieldPath,
    candidates: readonly ConfigSourceKind[],
  ): ConfigAuthorityMetadata | undefined => {
    for (const sourceKind of candidates) {
      const config = sourceConfigs.get(sourceKind)
      if (config && hasConfigField(config, fieldPath)) {
        return { fieldPath, sourceKind }
      }
    }
    return undefined
  }

  const fieldCandidates: Readonly<
    Record<ConfigAuthorityFieldPath, readonly ConfigSourceKind[]>
  > = {
    'bootstrap.enabled': ['custom', 'project', 'user'],
    'bootstrap.file': ['custom', 'project', 'user'],
    skills_as_commands: ['custom', 'project', 'user'],
    'workflow_guard.debug': ['custom', 'user'],
    'workflow_guard.mode': ['custom', 'user'],
  }
  for (const fieldPath of CONFIG_AUTHORITY_FIELD_PATHS) {
    const authority = firstDefinedSource(fieldPath, fieldCandidates[fieldPath])
    if (authority) authorities.push(authority)
  }

  const protectedFields = summary.sources.flatMap(
    (source) => source.protectedFields,
  )
  const sources = dedupeSourceMetadata(
    [summary.custom, summary.project, summary.user],
    sourcePaths,
  )
  return {
    authorities: sortAuthorities(authorities),
    protectedFields: sortProtectedFields(protectedFields),
    sources,
  }
}

function dedupeSourceMetadata(
  metadata: readonly ConfigSourceMetadata[],
  sourcePaths: ReadonlyMap<ConfigSourceKind, string>,
): readonly ConfigSourceMetadata[] {
  const seen = new Set<string>()
  return metadata.filter((source) => {
    const identity = sourcePaths.get(source.kind) ?? `missing:${source.kind}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function hasConfigField(
  config: RawSystematicConfig,
  fieldPath: ConfigAuthorityFieldPath,
): boolean {
  const [topLevel, nested] = fieldPath.split('.')
  if (nested === undefined)
    return config[topLevel as keyof RawSystematicConfig] !== undefined
  const value = config[topLevel as keyof RawSystematicConfig]
  return isRecord(value) && value[nested] !== undefined
}

function sortAuthorities(
  authorities: readonly ConfigAuthorityMetadata[],
): readonly ConfigAuthorityMetadata[] {
  return [...authorities].sort((left, right) =>
    left.fieldPath === right.fieldPath
      ? left.sourceKind.localeCompare(right.sourceKind)
      : left.fieldPath.localeCompare(right.fieldPath),
  )
}

function sortProtectedFields(
  fields: readonly ConfigProtectedFieldMetadata[],
): readonly ConfigProtectedFieldMetadata[] {
  return [...fields].sort((left, right) =>
    left.fieldPath === right.fieldPath
      ? left.sourceKind.localeCompare(right.sourceKind)
      : left.fieldPath.localeCompare(right.fieldPath),
  )
}

function mergeOverlaySources(sources: ConfigSource[]): SourcedOverlayConfigMap {
  const result: SourcedOverlayConfigMap = {
    agents: {},
    categories: {},
  }

  for (const source of sources) {
    mergeOverlayMap(result.agents, source, 'agents')
    mergeOverlayMap(result.categories, source, 'categories')
  }

  return result
}

function mergeOverlayMap(
  target: Record<string, SourcedOverlayConfig>,
  source: ConfigSource,
  mapKey: 'agents' | 'categories',
): void {
  const overlayMap = source.config[mapKey]
  if (overlayMap === undefined) return

  if (!isRecord(overlayMap)) {
    throwInvalidOverlay(source.path, mapKey)
  }

  for (const [key, value] of Object.entries(overlayMap)) {
    const keyPath = `${mapKey}.${key}`
    if (!isRecord(value)) {
      throwInvalidOverlay(source.path, keyPath)
    }

    if (source.trust === 'project') {
      rejectProjectSecurityOverlay(source.path, keyPath, value)
    }

    const previous = target[key]
    const nextValue =
      source.trust === 'project' && previous
        ? preserveSecurityFields(previous.value, value)
        : value

    target[key] = {
      value: nextValue,
      sourcePath: source.path,
      keyPath,
    }
  }
}

function rejectProjectSecurityOverlay(
  sourcePath: string,
  keyPath: string,
  value: Record<string, unknown>,
): void {
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new Error(
        `Invalid Systematic config in ${sourcePath}: ${keyPath}.${field} is only valid in user config or OPENCODE_CONFIG_DIR config`,
      )
    }
  }
}

function preserveSecurityFields(
  previous: OverlayConfig,
  next: OverlayConfig,
): OverlayConfig {
  const result: OverlayConfig = { ...next }
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(previous, field)) {
      result[field] = previous[field]
    }
  }
  return result
}

const PI_SUBAGENTS_PROTECTED_FIELD_SET = new Set(PI_SUBAGENTS_PROTECTED_FIELDS)

/**
 * Merge `pi_subagents.categories`/`pi_subagents.agents` overlays across
 * config sources, in trust order. Unlike the portable `SECURITY_OVERLAY_FIELDS`
 * (model/variant/skills/permission on `agents`/`categories`), which reject a
 * project-sourced attempt outright, the pi_subagents-protected fields
 * (`thinking`, `tools`, `skills`) are silently stripped from project-sourced
 * config before merge — project config simply cannot grant them. `max_turns`
 * is trust-any and passes through unchanged. This mirrors the plan's R18
 * trust lattice: project cannot grant tools/skills to an exported persona.
 */
function mergePiSubagentsOverlaySources(
  sources: ConfigSource[],
): SourcedOverlayConfigMap {
  const result: SourcedOverlayConfigMap = {
    agents: {},
    categories: {},
  }

  for (const source of sources) {
    mergePiSubagentsOverlayMap(result.agents, source, 'agents')
    mergePiSubagentsOverlayMap(result.categories, source, 'categories')
  }

  return result
}

function stripPiSubagentsProtectedFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [field, fieldValue] of Object.entries(value)) {
    if (PI_SUBAGENTS_PROTECTED_FIELD_SET.has(field)) continue
    result[field] = fieldValue
  }
  return result
}

/**
 * Preserve protected fields from a higher-trust previous value when a
 * project-sourced overlay replaces the same key wholesale. Mirrors
 * `preserveSecurityFields` for the portable `agents`/`categories` overlay —
 * a project same-key overlay must not silently erase a user-set
 * `thinking`/`tools`/`skills` value.
 */
function preservePiSubagentsProtectedFields(
  previous: OverlayConfig,
  next: OverlayConfig,
): OverlayConfig {
  const result: OverlayConfig = { ...next }
  for (const field of PI_SUBAGENTS_PROTECTED_FIELD_SET) {
    if (Object.hasOwn(previous, field)) {
      result[field] = previous[field]
    }
  }
  return result
}

function mergePiSubagentsOverlayMap(
  target: Record<string, SourcedOverlayConfig>,
  source: ConfigSource,
  mapKey: 'agents' | 'categories',
): void {
  const overlayMap = source.config.pi_subagents?.[mapKey]
  if (overlayMap === undefined) return

  if (!isRecord(overlayMap)) {
    throwInvalidOverlay(source.path, `pi_subagents.${mapKey}`)
  }

  for (const [key, rawValue] of Object.entries(overlayMap)) {
    const keyPath = `pi_subagents.${mapKey}.${key}`
    if (!isRecord(rawValue)) {
      throwInvalidOverlay(source.path, keyPath)
    }

    const previous = target[key]
    const value =
      source.trust === 'project'
        ? preservePiSubagentsProtectedFields(
            previous?.value ?? {},
            stripPiSubagentsProtectedFields(rawValue),
          )
        : rawValue

    target[key] = {
      value,
      sourcePath: source.path,
      keyPath,
    }
  }
}

function overlayValues(
  overlays: Record<string, SourcedOverlayConfig>,
): OverlayConfigMap {
  const result: OverlayConfigMap = {}

  for (const [key, overlay] of Object.entries(overlays)) {
    result[key] = overlay.value
  }

  return result
}

function throwInvalidOverlay(sourcePath: string, keyPath: string): never {
  throw new Error(
    `Invalid Systematic config in ${sourcePath}: ${keyPath} must be an object`,
  )
}

interface ConfigPathOptions {
  readonly homeDir?: string
  readonly userConfigDir?: string
  readonly customConfigDir?: string | null
}

export function getConfigPaths(
  projectDir: string,
  options?: ConfigPathOptions,
) {
  const homeDir = options?.homeDir ?? os.homedir()
  const userConfigDir =
    options?.userConfigDir ?? path.join(homeDir, '.config/opencode')
  const customConfigDir =
    options !== undefined && Object.hasOwn(options, 'customConfigDir')
      ? options.customConfigDir?.trim()
      : process.env.OPENCODE_CONFIG_DIR?.trim()

  const result = {
    userConfig: resolveConfigPath(userConfigDir, 'systematic'),
    projectConfig: resolveConfigPath(
      path.join(projectDir, '.opencode'),
      'systematic',
    ),
    userDir: path.join(homeDir, '.config/opencode/systematic'),
    projectDir: path.join(projectDir, '.opencode/systematic'),
    ...(customConfigDir && {
      customConfig: resolveConfigPath(customConfigDir, 'systematic'),
      customDir: path.join(customConfigDir, 'systematic'),
    }),
  }

  return result
}
