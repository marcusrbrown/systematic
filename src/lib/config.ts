import fs from 'node:fs'
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
  CONFIG_PROTECTED_FIELD_PATHS,
  type ConfigProtectedFieldPath,
} from './config-protected-fields.js'
import {
  PI_SUBAGENTS_PROTECTED_FIELDS,
  SECURITY_OVERLAY_FIELDS,
  SystematicConfigSchema,
} from './config-schema.js'
import {
  REMOVED_BUNDLED_AGENT_CATEGORIES,
  REMOVED_CONFIG_KEYS,
} from './removed-names.js'
import {
  collectWrittenLegacyPiSubagentsThinkingWarnings,
  qualifierResolvesWithoutModel,
  type RoutingTarget,
  resolveRouting,
} from './routing-resolver.js'
import { readBytesBounded } from './search-bounded-read.js'
import { lookupSearchRoot } from './search-corpus.js'
import {
  configEntryExists,
  findStartDirProjectConfig,
  MAX_PROJECT_CONFIG_BYTES,
  mergeSearchSettings,
  resolveUserLevelConfigDirs,
  type SearchSchemaOutput,
  type SearchSettingsSource,
  selectConfigFile,
  selectProjectConfigFile,
  selectUserLevelConfigFiles,
  startDirProjectWarning,
  type UserLevelLayer,
  validateSearchConfig,
} from './search-user-config.js'

export interface BootstrapConfig {
  enabled: boolean
  file?: string
}

export type OverlayConfig = Record<string, unknown>

export type OverlayConfigMap = Record<string, OverlayConfig>

/**
 * Which FILE-level source contributed the winning value for one routing
 * field -- distinct from `RoutingFieldSource.level`/`.form` in
 * `routing-resolver.ts`, which describe SHAPE provenance (agent vs
 * category, block vs flat), not file provenance. Reuses `ConfigSourceKind`
 * for the non-profile cases (a plain agents/categories overlay entry from
 * that trust level) and adds the three profile-bundle variants, since a
 * bundle's own trust level (which file defined `profiles.<name>`) is a
 * genuinely different fact from an ordinary same-trust overlay -- most
 * importantly, `'project-profile'` is the only origin an advisory
 * (project-sourced) bundle can ever produce, and is exactly the tag
 * `config show` needs to make "the project bundle applied something"
 * distinguishable from "the project bundle got fully absorbed by user
 * config" (every field's origin reads `'user'`, never `'project-profile'`).
 */
export type RoutingValueOrigin =
  | ConfigSourceKind
  | 'user-profile'
  | 'custom-profile'
  | 'project-profile'

/**
 * Per-leaf file-provenance for the exact set of fields
 * `routing-resolver.ts` ever reads off a merged agent/category overlay
 * value: the two flat fields (`model`, `variant`) and the four
 * harness-block fields (`opencode.model`, `opencode.variant`, `pi.model`,
 * `pi.thinking`). Deliberately NOT a generic recursive mirror of
 * `OverlayConfig`'s shape -- routing is the only consumer, and a generic
 * tree would have to track every overlay field (`mode`, `color`, `steps`,
 * `hidden`, `disable`, `skills`, `permission`, ...) for no benefit, since
 * none of those ever feed routing resolution.
 *
 * A leaf is `undefined` when no source in the merge chain has ever set
 * that field as an OWN property for this key -- distinct from the field
 * being unresolved at the routing layer (which can also happen when a
 * lower-precedence layer, e.g. category, is shadowed by a higher one, e.g.
 * agent, that DOES have an origin here).
 */
export interface RoutingFieldOrigins {
  readonly model?: RoutingValueOrigin
  readonly variant?: RoutingValueOrigin
  readonly opencodeModel?: RoutingValueOrigin
  readonly opencodeVariant?: RoutingValueOrigin
  readonly piModel?: RoutingValueOrigin
  readonly piThinking?: RoutingValueOrigin
}

export interface SourcedOverlayConfig {
  value: OverlayConfig
  sourcePath: string
  keyPath: string
  /**
   * Per-routing-field file provenance for `value`, updated in lockstep
   * with `value` at every merge step (see `resolveOverlayEntryOrigin`) --
   * attached to the value that actually won, never derived after the fact
   * from `sourcePath` (which is last-writer-wins across the WHOLE entry,
   * not per field; see that field's doc comment for the trap this avoids).
   * Optional and possibly `{}` for overlay maps this file's merge doesn't
   * populate origins for (`pi_subagents`, and `routing-resolver.ts`'s
   * `toSourcedOverlayMap` placeholder adapter for already-flattened
   * inputs) -- routing resolution treats a missing leaf as "no known
   * origin", never as an error.
   */
  origins?: RoutingFieldOrigins
}

export interface SourcedOverlayConfigMap {
  agents: Record<string, SourcedOverlayConfig>
  categories: Record<string, SourcedOverlayConfig>
}

export const CONFIG_AUTHORITY_FIELD_PATHS = [
  'bootstrap.enabled',
  'bootstrap.file',
  'skills_as_commands',
] as const

export { CONFIG_PROTECTED_FIELD_PATHS, type ConfigProtectedFieldPath }

export type ConfigSourceKind = 'custom' | 'project' | 'user'
export type ConfigSourcePresence = 'absent' | 'invalid' | 'present'
export type ConfigSourceErrorCode =
  | 'parse-failed'
  | 'read-failed'
  | 'schema-invalid'
  | 'source-invalid'
export type ConfigAuthorityFieldPath =
  (typeof CONFIG_AUTHORITY_FIELD_PATHS)[number]

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

/**
 * The source kind that supplied the winning `profile` selector value, or
 * `null` when no source set `profile` at all (case 1 of the selection table
 * in plan 2026-09-04-002-feat-model-config-profiles, Unit 2). This names
 * whichever source's value won the `SYSTEMATIC_PROFILE ?? custom ?? project
 * ?? user` selector lookup -- including when that value turned out to name
 * a missing bundle and the loader fell back to the user's own default (see
 * {@link ConfigObservationMetadata.profileFallback}). `'environment'` is
 * distinct from `ConfigSourceKind` deliberately: it names an env var
 * override, never a config file, and must never be mistaken for one.
 */
export type ProfileSelectorSource = ConfigSourceKind | 'environment' | null

/**
 * Present when the winning `profile` selector named a bundle absent from
 * the user source's `profiles` map. `usedDefault` names the user's own
 * default profile if it resolved instead, or `null` if the loader fell back
 * to base configuration (no profile).
 */
export interface ProfileFallbackMetadata {
  readonly requested: string
  readonly usedDefault: string | null
}

export interface ConfigObservationMetadata {
  readonly authorities: readonly ConfigAuthorityMetadata[]
  readonly protectedFields: readonly ConfigProtectedFieldMetadata[]
  readonly sources: readonly ConfigSourceMetadata[]
  /** The active profile's name, or `null` when base configuration is active. */
  readonly activeProfile: string | null
  readonly profileSelectorSource: ProfileSelectorSource
  readonly profileFallback: ProfileFallbackMetadata | null
}

export interface SourceAwareConfigResult {
  config: SystematicConfig
  metadata: ConfigObservationMetadata
  overlays: SourcedOverlayConfigMap
  /**
   * Merged `pi_subagents.{agents,categories}` overlays (three-entry chain --
   * user, project, custom; no profile pseudo-entry, see the merge-order
   * comment in `loadConfigWithSources`). Exposed so a caller building a
   * routing table (e.g. `systematic config show`) can pass the exact same
   * legacy-`thinking`-fallback input `resolveRouting` uses internally for
   * the post-merge qualifier check, without recomputing it.
   */
  piSubagentsOverlays: SourcedOverlayConfigMap
  /**
   * The (non-canonical) `path` of the file that defined the active
   * profile's bundle content -- `profileSelection.bundleSource.path`,
   * verbatim -- or `null` when no profile is active. Deliberately lives
   * here and NOT on `ConfigObservationMetadata`: `capability-snapshot.ts`
   * runs loader metadata through `assertAllowedKeys`, a hardcoded-allowlist
   * gate that THROWS on any unknown key (see its doc comment), and only
   * `.metadata` -- never the rest of `SourceAwareConfigResult` -- is an
   * input to the capability snapshot. Adding a field to
   * `ConfigObservationMetadata` would silently break `systematic
   * capabilities` (`runCapabilities` catches the throw and prints
   * "Capabilities diagnostic unavailable", naming no cause) exactly the way
   * a hand-duplicated `CONFIG_PROTECTED_FIELD_PATHS` literal in
   * `capability-snapshot.ts` once silently did, before that duplication was
   * removed in favor of the shared `config-protected-fields.ts` module (see
   * that module's doc comment for the incident record). Consumers
   * (`systematic config show`) read `loaded.activeProfileSourcePath`
   * directly, never `loaded.metadata.activeProfileSourcePath`. Uses `path`
   * (matching `getConfigPaths`/`Configuration locations`'s non-canonical
   * values), not `canonicalPath` -- printing the canonical path would
   * disagree with the `Configuration locations` block a few lines above it
   * for a symlinked config directory.
   */
  activeProfileSourcePath: string | null
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
  agents?: OverlayConfigMap
  categories?: OverlayConfigMap
  pi_subagents?: PiSubagentsOverlayMap
  skills_as_commands: boolean
  allow_project_profiles: boolean
  /**
   * Merged `search` settings from user and custom config only: `enabled`
   * (last-defining), `allow_project_sources` (union) and the user `sources`
   * (by name, custom winning). Absent when neither defines one: there is no
   * default, and the core applies its own at use time. A project config's
   * `search.sources` are validated at load and then discarded; they never
   * appear here. The per-call external reader is their only consumer.
   */
  search?: SearchSchemaOutput
  /**
   * Set (to `true`) when a user or custom `search` block, or its file, could
   * not be read. That block is ignored and search results carry a
   * `config unreadable` note. Absent otherwise.
   */
  searchUnreadable?: boolean
}

export const DEFAULT_CONFIG: SystematicConfig = {
  disabled_skills: [],
  disabled_agents: [],
  disabled_commands: [],
  bootstrap: {
    enabled: true,
  },
  agents: {},
  categories: {},
  pi_subagents: { categories: {}, agents: {} },
  skills_as_commands: true,
  allow_project_profiles: false,
}

/**
 * A routing-only overlay bundle as parsed from a `profiles.<name>` entry.
 * Shape mirrors `ProfileBundleSchema` in config-schema.ts (`{agents?,
 * categories?}` of routing-only overlay fragments); kept as `unknown`-typed
 * fields here since the loader treats overlay values opaquely, same as the
 * top-level `agents`/`categories` maps below.
 */
interface RawProfileBundle {
  agents?: unknown
  categories?: unknown
}

interface RawSystematicConfig
  extends Omit<
    Partial<SystematicConfig>,
    'agents' | 'categories' | 'pi_subagents' | 'search' | 'searchUnreadable'
  > {
  agents?: unknown
  categories?: unknown
  pi_subagents?: { categories?: unknown; agents?: unknown }
  /** Raw and unvalidated: `splitSearchBlock` validates it apart from the rest of the file. */
  search?: unknown
  profiles?: Record<string, RawProfileBundle>
  profile?: string | null
}

interface ConfigSourceBase {
  readonly canonicalPath: string
  readonly path: string
  readonly config: RawSystematicConfig
  readonly protectedFields: readonly ConfigProtectedFieldMetadata[]
}

/**
 * The position a file holds in the chain. `user.local` and `custom.local` are
 * the overlay files beside the user and custom files: they share their
 * sibling's trust but are a layer of their own, which is what the overlay
 * merge branches on.
 */
type ConfigSourceLayer = UserLevelLayer | 'project'

const LAYER_TRUST = {
  user: 'user',
  'user.local': 'user',
  project: 'project',
  custom: 'custom',
  'custom.local': 'custom',
} as const satisfies Record<ConfigSourceLayer, ConfigSourceKind>

/** A config source loaded from an actual file: a user, project, or custom file, or a local overlay beside one. */
interface FileConfigSource extends ConfigSourceBase {
  readonly kind: 'file'
  readonly layer: ConfigSourceLayer
  /** Keys from `REMOVED_CONFIG_KEYS` this file carries, whatever their value. */
  readonly removedKeys: readonly string[]
  /**
   * The file's `search` block, validated on its own and split off the rest
   * of the file before `SystematicConfigSchema.safeParse`, so a bad block
   * can never fail the load. Absent for project sources (whose `sources` are
   * validated and then discarded) and for files with no `search` key.
   */
  readonly search?: SearchSettingsSource
  readonly trust: ConfigSourceKind
}

/**
 * The synthetic pseudo-source built from the active profile bundle (see
 * `resolveActiveProfile` / the `profileEntry` construction in
 * `loadConfigWithSources`). A distinct discriminated-union member, not a
 * boolean flag layered on a `FileConfigSource` -- it has no `trust` field at
 * all, so every place that decides project-only behavior
 * (`stripProjectSecurityOverlay` via `source.trust === 'project'`,
 * `preserveSecurityFields`) type-narrows away from this member first and
 * can never mistake it for a project source. It may be defined in EITHER
 * the user config file or the custom (`OPENCODE_CONFIG_DIR`) config file --
 * whichever one actually defines the active bundle -- and its
 * `sourcePath`/`canonicalPath` mirror that defining file, not necessarily
 * the user file (see `resolveActiveProfile`'s `bundleSource` field). Its
 * merge behavior in `mergeOverlayMap` differs from an ordinary overlay
 * source: switching which profile is active must never change an agent's
 * visibility, permissions, or existence (R7/R10), so the profile layer
 * merges field-by-field over the base value instead of the narrower
 * security+trustAny preserve used for an ordinary user/custom same-key
 * override. It is also never counted as a file source in the
 * `sources`/`authorities` observation metadata --
 * `ConfigSourceLoadSummary.sources` is typed `readonly FileConfigSource[]`
 * and is populated from a separate, profile-free source list (see the
 * `sources` vs `overlaySources` split in `loadConfigWithSources`), so this
 * member cannot reach that code path even by mistake.
 */
interface ProfileBundleConfigSource extends ConfigSourceBase {
  readonly kind: 'profile-bundle'
  /**
   * The active profile's name. Always a real name (never `null`) --
   * `profileEntry`'s construction only builds this pseudo-source when
   * `ProfileSelectionResult.bundle` is set, which only ever happens
   * alongside a string `activeProfile` (see `resolveActiveProfile`).
   * `mergeOverlayMap` uses this to prefix the merged overlay's `keyPath`
   * with `profiles.<name>.` so a downstream validation error naming a
   * profile-supplied overlay (`validateExactAgentOverlays`,
   * `validateCategoryOverlays`) points at the profile and its defining
   * file, not at a bare `agents.<key>` path that looks like it came from
   * the top level.
   */
  readonly profileName: string
  /**
   * The trust level of the FILE that defined this bundle's `profiles.<name>`
   * entry -- `profileSelection.bundleSource.trust`, carried onto the
   * pseudo-source itself so `originForSource` can tag a routing field's
   * origin as `'user-profile'`/`'custom-profile'`/`'project-profile'`
   * without threading `profileSelection` separately through the merge
   * functions. Distinct from this pseudo-source having no `trust` field of
   * its own (see this interface's doc comment) -- `bundleTrust` names
   * where the bundle's CONTENT came from, not a trust level this
   * pseudo-source itself holds for stripping/preservation purposes.
   */
  readonly bundleTrust: ConfigSourceKind
}

type ConfigSource = FileConfigSource | ProfileBundleConfigSource

type SecurityOverlayField = (typeof SECURITY_OVERLAY_FIELDS)[number]

const PROTECTED_OVERLAY_FIELD_PATHS = {
  agents: {
    model: 'agents.*.model',
    permission: 'agents.*.permission',
    skills: 'agents.*.skills',
    variant: 'agents.*.variant',
    opencode: 'agents.*.opencode',
    pi: 'agents.*.pi',
  },
  categories: {
    model: 'categories.*.model',
    permission: 'categories.*.permission',
    skills: 'categories.*.skills',
    variant: 'categories.*.variant',
    opencode: 'categories.*.opencode',
    pi: 'categories.*.pi',
  },
} satisfies Record<
  'agents' | 'categories',
  Record<SecurityOverlayField, ConfigProtectedFieldPath>
>

// `allow_project_profiles` is unconditionally project-protected. `search` is
// protected per nested path (`search.enabled`, `search.allow_project_sources`),
// because a project may still set `search.sources`. Those two paths are
// reported by `collectProjectProtectedFields`, and `splitSearchBlock` then
// reads a project's block for `sources` alone and discards it, so neither
// value can reach the resolved config. `profiles` is deliberately NOT in this set -- it is conditionally protected on the
// effective `allow_project_profiles` opt-in (see
// `stripProjectProtectedFields`/`collectProjectProtectedFields`). A project can
// never grant itself that opt-in, since `allow_project_profiles` itself is
// always stripped regardless of its value.
const PROJECT_ALWAYS_PROTECTED_FIELDS = new Set(['allow_project_profiles'])

/** The `search` fields only user and custom config may set. */
const PROJECT_PROTECTED_SEARCH_FIELDS = [
  ['enabled', 'search.enabled'],
  ['allow_project_sources', 'search.allow_project_sources'],
] as const satisfies ReadonlyArray<readonly [string, ConfigProtectedFieldPath]>

/** Max rendered length (including a truncation ellipsis) for untrusted text interpolated into a diagnostic message. */
const MAX_DIAGNOSTIC_TEXT = 200

/** Max detailed per-field strip warnings emitted for one project source load, before the rest collapse into a single summary. */
const MAX_STRIP_WARNINGS = 20

const DIAGNOSTIC_ELLIPSIS = '\u2026'

/**
 * Render untrusted text (a project-authored `agents`/`categories` key, or a
 * config file path) safely for interpolation into a diagnostic message.
 * Ordinary short text passes through unchanged. Control characters (C0,
 * DEL, C1) and the Unicode line separators (U+2028/U+2029) are escaped to
 * `\uXXXX` so they cannot inject fake terminal/log lines. Output is capped
 * at `MAX_DIAGNOSTIC_TEXT` characters (ellipsis included); the raw input is
 * only ever scanned up to that same bound, so an arbitrarily large input
 * costs bounded work, not `JSON.stringify`-over-everything work.
 */
function sanitizeDiagnosticText(input: string): string {
  const budget = MAX_DIAGNOSTIC_TEXT - DIAGNOSTIC_ELLIPSIS.length
  let rendered = ''
  let truncated = false
  for (const char of input) {
    if (rendered.length >= budget) {
      truncated = true
      break
    }
    const code = char.codePointAt(0) ?? 0
    const isControl =
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    const piece = isControl ? `\\u${code.toString(16).padStart(4, '0')}` : char
    if (rendered.length + piece.length > budget) {
      truncated = true
      break
    }
    rendered += piece
  }
  return truncated ? `${rendered}${DIAGNOSTIC_ELLIPSIS}` : rendered
}

/**
 * Bound the number of detailed strip warnings emitted for one project
 * source load. The first `MAX_STRIP_WARNINGS` messages pass straight
 * through to `warningSink`; every one after that is counted instead of
 * emitted, so a project config with hundreds of protected fields can't
 * flood the warning sink -- stripping itself is never affected, only how
 * many of its warnings are individually reported. State is local to one
 * call (a fresh counter per load), not module-global.
 */
function createBoundedStripWarningSink(
  warningSink: (message: string) => void,
): { readonly sink: (message: string) => void; suppressedCount(): number } {
  let emitted = 0
  let suppressed = 0
  return {
    sink(message: string) {
      if (emitted < MAX_STRIP_WARNINGS) {
        emitted++
        warningSink(message)
      } else {
        suppressed++
      }
    },
    suppressedCount() {
      return suppressed
    },
  }
}

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
 * Bare agent key -> category, and category -> bare agent keys, derived from
 * `BUNDLED_AGENT_QUALIFIED_IDS` ("category/key" strings) without any
 * filesystem access. Used by the routing-resolver post-merge check
 * (`assertRoutingInvariants`) to enumerate real targets from the merged
 * overlays: every bundled agent has exactly one category (`agents/` is
 * one level of category subdirectories, `agentQualifiedIds` in
 * `scripts/generate-config-schema.ts` derives one qualified id per bundled
 * agent), so these maps are complete and don't need `agent-overlays.ts`'s
 * heavier `buildBundledAgentInventory` (which requires an `agentsDir` path
 * `loadConfigWithSources` doesn't have).
 */
const BUNDLED_AGENT_CATEGORY_BY_KEY: ReadonlyMap<string, string> = new Map(
  BUNDLED_AGENT_QUALIFIED_IDS.map((qualifiedId) => {
    const separatorIndex = qualifiedId.indexOf('/')
    return [
      qualifiedId.slice(separatorIndex + 1),
      qualifiedId.slice(0, separatorIndex),
    ] as const
  }),
)

const BUNDLED_AGENT_KEYS_BY_CATEGORY: ReadonlyMap<string, readonly string[]> =
  (() => {
    const byCategory = new Map<string, string[]>()
    for (const [agentKey, category] of BUNDLED_AGENT_CATEGORY_BY_KEY) {
      const existing = byCategory.get(category) ?? []
      existing.push(agentKey)
      byCategory.set(category, existing)
    }
    return byCategory
  })()

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

function isErrorWithCode(error: unknown): error is Error & { code?: unknown } {
  return error instanceof Error && 'code' in error
}

/** Part of the error text for a project file over the size cap. */
const OVERSIZED_FILE_REASON = `file is larger than ${MAX_PROJECT_CONFIG_BYTES / (1024 * 1024)} MB`

function readConfigText(
  filePath: string,
  maxBytes: number | undefined,
): string | null {
  if (maxBytes === undefined) {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (error) {
      // A directory entry at the path is a link whose target is gone: reported.
      if (
        isErrorWithCode(error) &&
        error.code === 'ENOENT' &&
        !configEntryExists(filePath)
      ) {
        return null
      }
      throw new Error(
        `Invalid Systematic config in ${filePath}: unable to read file`,
        { cause: error },
      )
    }
  }
  const read = readBytesBounded(filePath, maxBytes)
  switch (read.kind) {
    case 'bytes':
      return read.bytes.toString('utf-8')
    case 'absent':
      if (!configEntryExists(filePath)) return null
      throw new Error(
        `Invalid Systematic config in ${filePath}: unable to read file`,
      )
    case 'too-large':
      throw new Error(
        `Invalid Systematic config in ${filePath}: unable to read file (${OVERSIZED_FILE_REASON})`,
      )
    default:
      throw new Error(
        `Invalid Systematic config in ${filePath}: unable to read file`,
      )
  }
}

/**
 * @param maxBytes Bounds the read. The project pass sets it so a cloned
 * repository cannot hand the loader an arbitrarily large file; user-level
 * files are read whole.
 */
function loadJsoncFile(
  filePath: string,
  maxBytes?: number,
): RawSystematicConfig | null {
  const content = readConfigText(filePath, maxBytes)
  if (content === null) return null

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
 * Format the human-readable hint for an unrecognized agent key inside a
 * profile bundle (`profiles.<name>.agents`). Unlike the top-level `agents`
 * field's hint, this names the full `profiles.<name>.agents.<key>` path
 * for each bad key, so a validation error on a profile-supplied overlay
 * points at the profile that defined it, not a bare top-level-looking path.
 */
function formatProfileAgentUnrecognizedKeysHint(
  badKeys: readonly string[],
  profileName: string,
): string {
  const prefixed = badKeys.map((k) => `profiles.${profileName}.agents.${k}`)
  const isAre =
    prefixed.length === 1 ? 'is not a bundled agent' : 'are not bundled agents'
  return `${prefixed.join(', ')} ${isAre}. See ${TYPED_VALIDATION_DOCS_URL} for the full list of valid names.`
}

/**
 * Post-process Zod issues to enrich unrecognized-key errors on typed fields
 * (agents, disabled_agents, disabled_skills, and profiles.<name>.agents)
 * with a pointer to the docs URL where the full list of valid bundled names
 * is published.
 *
 * Also suppresses the verbose enum list that Zod emits for invalid_value
 * issues on disabled_agents and disabled_skills, replacing it with a short
 * hint that surfaces the bad value and points at the docs URL.
 *
 * Returns the issues array unchanged when no enrichment is needed.
 */
/**
 * A typo'd agent key inside a profile bundle (`profiles.<name>.agents`).
 * Detected before the top-level `TYPED_KEY_FIELDS` gate since
 * `issue.path[0]` here is `'profiles'`, not `'agents'`. Returns `null` when
 * the issue does not match this shape.
 */
function enrichProfileAgentUnrecognizedKeysIssue(
  issue: z.core.$ZodIssue,
): z.core.$ZodIssue | null {
  if (
    issue.code !== 'unrecognized_keys' ||
    issue.path[0] !== 'profiles' ||
    issue.path[2] !== 'agents' ||
    typeof issue.path[1] !== 'string'
  ) {
    return null
  }
  const hint = formatProfileAgentUnrecognizedKeysHint(issue.keys, issue.path[1])
  return { ...issue, message: hint }
}

/**
 * A typo'd key on one of the top-level `TYPED_KEY_FIELDS`
 * (`agents`/`disabled_agents`/`disabled_skills`). Returns `null` when the
 * issue does not match this shape.
 */
function enrichTopLevelTypedKeyIssue(
  issue: z.core.$ZodIssue,
  rawInput: unknown,
): z.core.$ZodIssue | null {
  const topField = issue.path[0]
  if (typeof topField !== 'string' || !TYPED_KEY_FIELDS.has(topField)) {
    return null
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

  return null
}

function enrichUnrecognizedKeyIssues(
  issues: readonly z.core.$ZodIssue[],
  rawInput: unknown,
): readonly z.core.$ZodIssue[] {
  return issues.map(
    (issue) =>
      enrichProfileAgentUnrecognizedKeysIssue(issue) ??
      enrichTopLevelTypedKeyIssue(issue, rawInput) ??
      issue,
  )
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
  trust: ConfigSourceKind,
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

interface LoadedConfigSource {
  readonly metadata: ConfigSourceMetadata
  readonly source: FileConfigSource | null
}

interface ConfigSourceLoadInput {
  readonly filePath: string
  readonly layer: ConfigSourceLayer
  readonly invalidSource: 'throw' | 'report'
  /** Where strip and validation warnings go. For the project layer this is the bounded, alias-buffered sink. */
  readonly warningSink: (message: string) => void
  /** Called in `report` mode for a file that failed to load. Not buffered or capped. */
  readonly reportInvalid: (
    filePath: string,
    code: ConfigSourceErrorCode,
  ) => void
  /**
   * The effective opt-in, resolved by the caller before this source is
   * loaded. Only consulted for the project layer; user-level loads pass
   * `false`.
   */
  readonly allowProjectProfiles: boolean
}

function loadConfigSource(input: ConfigSourceLoadInput): LoadedConfigSource {
  const { filePath, layer, invalidSource, warningSink, allowProjectProfiles } =
    input
  const trust = LAYER_TRUST[layer]
  try {
    const rawConfig = loadJsoncFile(
      filePath,
      layer === 'project' ? MAX_PROJECT_CONFIG_BYTES : undefined,
    )
    if (!rawConfig) {
      return {
        metadata: { kind: trust, presence: 'absent' },
        source: null,
      }
    }

    const protectedFields = collectProjectProtectedFields(
      rawConfig,
      trust,
      allowProjectProfiles,
    )
    const topLevelStripped =
      trust === 'project'
        ? stripProjectProtectedFields(rawConfig, allowProjectProfiles)
        : rawConfig
    // Security-overlay fields are stripped here, pre-validation -- see `stripProjectSecurityOverlayFields`.
    const config =
      trust === 'project'
        ? stripProjectSecurityOverlayFields(
            topLevelStripped,
            filePath,
            warningSink,
          )
        : topLevelStripped

    // Validated apart from the rest of the file, so a bad block drops with a
    // warning instead of failing the whole load. A project's block (its
    // `sources` only, after the strip above) is validated and then discarded.
    const { config: configWithoutSearch, search } = splitSearchBlock(
      config,
      filePath,
      trust,
      warningSink,
    )

    const result = SystematicConfigSchema.safeParse(configWithoutSearch)
    if (!result.success) {
      throwTopLevelConfigSchemaError(
        filePath,
        trust,
        result.error.issues,
        configWithoutSearch,
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
        kind: 'file',
        layer,
        canonicalPath: resolveConfigSourcePath(filePath),
        config: configWithoutSearch,
        path: filePath,
        protectedFields,
        removedKeys: REMOVED_CONFIG_KEYS.filter((key) =>
          Object.hasOwn(rawConfig, key),
        ),
        ...(search && { search }),
        trust,
      },
    }
  } catch (error) {
    if (invalidSource === 'throw') throw error
    const errorCode = classifyConfigSourceError(error)
    input.reportInvalid(filePath, errorCode)
    return {
      metadata: { errorCode, kind: trust, presence: 'invalid' },
      source: null,
    }
  }
}

/**
 * Split a file's `search` block off and validate it alone with the shared
 * field-and-entry validators. A user or custom block gives its valid parts
 * plus the `unreadable` flag. A project block is read for `sources`
 * alone (the validator ignores `enabled` and `allow_project_sources` under
 * project trust, which `collectProjectProtectedFields` and the per-path
 * warnings already report), validated for its warnings, and then discarded,
 * because the per-call reader is the only consumer of project `sources`. Only `settings` and `unreadable` of the result are consumed here;
 * a project's `structural` state belongs to that reader.
 */
function splitSearchBlock(
  config: RawSystematicConfig,
  filePath: string,
  trust: ConfigSourceKind,
  warningSink: (message: string) => void,
): { config: RawSystematicConfig; search: SearchSettingsSource | undefined } {
  if (!Object.hasOwn(config, 'search')) return { config, search: undefined }
  const { search: rawSearch, ...rest } = config as Record<string, unknown>
  const validation = validateSearchConfig(
    rawSearch,
    trust === 'project' ? 'project' : 'user',
    filePath,
  )
  for (const message of validation.warnings) warningSink(message)
  return {
    config: rest as RawSystematicConfig,
    search:
      trust === 'project'
        ? undefined
        : { settings: validation.settings, unreadable: validation.unreadable },
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

/**
 * Warn once when a top-level protected field (`profiles`,
 * `allow_project_profiles`) was present on a project-trust source and has
 * already been stripped -- extracted from `loadConfigWithSources` to keep
 * its cognitive complexity down; each call site supplies only the field
 * name and message body (with `%PATH%` standing in for the sanitized
 * source path, substituted here so every caller shares one sanitization
 * call site).
 */
function emitTopLevelProtectedFieldWarning(
  projectSource: FileConfigSource | null,
  fieldPath: ConfigProtectedFieldPath,
  messageTemplate: string,
  sink: (message: string) => void,
): void {
  if (
    !projectSource?.protectedFields.some(
      (field) => field.fieldPath === fieldPath,
    )
  ) {
    return
  }
  const safePath = sanitizeDiagnosticText(projectSource.path)
  sink(`[systematic] ${messageTemplate.replace('%PATH%', safePath)}`)
}

/** One per-path warning for each user-only `search` field a project source set. */
function emitProjectSearchProtectedWarnings(
  projectSource: FileConfigSource | null,
  sink: (message: string) => void,
): void {
  for (const [, fieldPath] of PROJECT_PROTECTED_SEARCH_FIELDS) {
    emitTopLevelProtectedFieldWarning(
      projectSource,
      fieldPath,
      `\`${fieldPath}\` in project config (%PATH%) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored. A project config may set \`search.sources\` only.`,
      sink,
    )
  }
}

/**
 * @param allowProjectProfiles The effective (already-resolved custom ??
 * user) opt-in value. Gates whether a project-set `profiles` is reported as
 * blocked -- `allow_project_profiles` itself is always blocked regardless of
 * this value (see `PROJECT_ALWAYS_PROTECTED_FIELDS`).
 */
function collectProjectProtectedFields(
  rawConfig: RawSystematicConfig,
  trust: ConfigSourceKind,
  allowProjectProfiles: boolean,
): readonly ConfigProtectedFieldMetadata[] {
  if (trust !== 'project') return []

  return [
    ...(!allowProjectProfiles && Object.hasOwn(rawConfig, 'profiles')
      ? [
          {
            fieldPath: 'profiles' as const,
            outcome: 'blocked' as const,
            sourceKind: 'project' as const,
          },
        ]
      : []),
    ...(Object.hasOwn(rawConfig, 'allow_project_profiles')
      ? [
          {
            fieldPath: 'allow_project_profiles' as const,
            outcome: 'blocked' as const,
            sourceKind: 'project' as const,
          },
        ]
      : []),
    ...collectSearchProtectedFields(rawConfig.search),
    ...collectOverlayProtectedFields(rawConfig.agents, 'agents'),
    ...collectOverlayProtectedFields(rawConfig.categories, 'categories'),
  ]
}

function collectSearchProtectedFields(
  search: unknown,
): readonly ConfigProtectedFieldMetadata[] {
  if (!isRecord(search)) return []
  return PROJECT_PROTECTED_SEARCH_FIELDS.filter(([key]) =>
    Object.hasOwn(search, key),
  ).map(([, fieldPath]) => ({
    fieldPath,
    outcome: 'blocked' as const,
    sourceKind: 'project' as const,
  }))
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

/**
 * `allow_project_profiles` is stripped unconditionally. `profiles` is stripped only when `allowProjectProfiles` is false (the
 * resolved custom ?? user opt-in) -- when true, `profiles` survives intact
 * into the parsed project source for `SystematicConfigSchema.safeParse` to
 * validate normally, same as it does for a user/custom source.
 */
function stripProjectProtectedFields(
  rawConfig: RawSystematicConfig,
  allowProjectProfiles: boolean,
): RawSystematicConfig {
  const config = { ...rawConfig }
  for (const field of PROJECT_ALWAYS_PROTECTED_FIELDS) {
    delete (config as Record<string, unknown>)[field]
  }
  if (!allowProjectProfiles) {
    delete (config as Record<string, unknown>).profiles
  }
  return config
}

/**
 * Strip `SECURITY_OVERLAY_FIELDS` from every `agents.<key>`/`categories.<key>`
 * entry of a project-trust raw config, BEFORE schema validation -- see the
 * call site in `loadConfigSource` for why this must happen ahead of
 * `SystematicConfigSchema.safeParse` rather than only at merge time.
 * Delegates the actual per-entry stripping (and its warning message) to
 * `stripProjectSecurityOverlay`, the same function the merge layer used to
 * call -- there is exactly one strip-and-warn implementation, just one call
 * site earlier in the pipeline now.
 *
 * `warningSink` is expected to already be bounded by the caller (see
 * `createBoundedStripWarningSink` at the `loadConfigWithSources` call site)
 * so the 20-detail cap is shared with the top-level `profiles`-ignored
 * warning instead of each owning a separate budget.
 *
 * A non-record `agents`/`categories` map, or a non-record per-key entry, is
 * left completely untouched (same object reference) so
 * `SystematicConfigSchema.safeParse` still reports its own "expected
 * object"-shaped error for that malformed shape -- ordinary validation, not
 * this sanitation step, owns that failure mode.
 */
function stripProjectSecurityOverlayFields(
  rawConfig: RawSystematicConfig,
  filePath: string,
  warningSink: (message: string) => void,
): RawSystematicConfig {
  const agents = stripSecurityOverlayEntries(
    rawConfig.agents,
    'agents',
    filePath,
    warningSink,
  )
  const categories = stripSecurityOverlayEntries(
    rawConfig.categories,
    'categories',
    filePath,
    warningSink,
  )
  if (agents === rawConfig.agents && categories === rawConfig.categories) {
    return rawConfig
  }
  const result: RawSystematicConfig = { ...rawConfig }
  if (agents !== rawConfig.agents) result.agents = agents
  if (categories !== rawConfig.categories) result.categories = categories
  return result
}

function stripSecurityOverlayEntries(
  overlayMap: unknown,
  mapKey: 'agents' | 'categories',
  filePath: string,
  warningSink: (message: string) => void,
): unknown {
  if (!isRecord(overlayMap)) return overlayMap

  let changed = false
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overlayMap)) {
    if (!isRecord(value)) {
      result[key] = value
      continue
    }
    const stripped = stripProjectSecurityOverlay(
      filePath,
      `${mapKey}.${key}`,
      value,
      warningSink,
    )
    if (stripped === value) {
      result[key] = stripped
      continue
    }
    changed = true
    // Drop an entry stripping left empty, so trusted settings elsewhere
    // survive instead of being replaced by a bare `{}` fragment.
    if (Object.keys(stripped).length === 0) continue
    result[key] = stripped
  }
  return changed ? result : overlayMap
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

const PROFILE_DOCS_URL =
  'https://fro.bot/systematic/reference/configuration#profiles'

/** The loaded file for each layer, `null` where a layer has no valid file. */
interface LayeredSources {
  readonly user: FileConfigSource | null
  readonly userLocal: FileConfigSource | null
  readonly project: FileConfigSource | null
  readonly custom: FileConfigSource | null
  readonly customLocal: FileConfigSource | null
}

/** The sources present, lowest layer first: user, user.local, project, custom, custom.local. */
function chainOf(layers: LayeredSources): FileConfigSource[] {
  return [
    layers.user,
    layers.userLocal,
    layers.project,
    layers.custom,
    layers.customLocal,
  ].filter((source): source is FileConfigSource => source !== null)
}

/**
 * The last value any source in `sources` defines for a top-level field.
 * "Defined" means not `undefined`, so an explicit `null` counts.
 */
function lastDefined<K extends keyof RawSystematicConfig>(
  sources: readonly (FileConfigSource | null)[],
  key: K,
): RawSystematicConfig[K] | undefined {
  let found: RawSystematicConfig[K] | undefined
  for (const source of sources) {
    const value = source?.config[key]
    if (value !== undefined) found = value
  }
  return found
}

interface ProfileSelectionInput {
  /** The loaded files by layer. A local file's `profile` and `profiles` rank above its sibling's. */
  readonly layers: LayeredSources
  /**
   * The resolved (custom ?? user) `allow_project_profiles` opt-in. Gates
   * whether `lookupProfileBundle` consults `projectSource.config.profiles`
   * at all -- redundant with the fact that `profiles` is already stripped
   * from `projectSource.config` when this is `false` (so the map would be
   * `undefined` anyway), but kept explicit so the anti-shadowing intent
   * reads directly at the lookup site rather than depending on stripping
   * having already happened upstream.
   */
  readonly allowProjectProfiles: boolean
  readonly warningSink: (message: string) => void
}

interface ProfileSelectionResult {
  readonly activeProfile: string | null
  readonly profileSelectorSource: ProfileSelectorSource
  readonly profileFallback: ProfileFallbackMetadata | null
  readonly bundle: RawProfileBundle | null
  /**
   * The file that actually defined `bundle` -- custom, user, or (only
   * under the `allow_project_profiles` opt-in) project, whichever
   * `lookupProfileBundle` found it in. `null` exactly when `bundle` is
   * `null`. Used to build `profileEntry`'s `canonicalPath`/`path` so a
   * profile defined only in custom config (with no user config file at
   * all) is attributed to the right file instead of silently defaulting
   * to a nonexistent user source -- and, for a project-sourced bundle, to
   * attribute `config show` provenance to the project config file even
   * though (this slice) it never enters the merge chain.
   */
  readonly bundleSource: FileConfigSource | null
}

const NO_PROFILE_SELECTION: ProfileSelectionResult = {
  activeProfile: null,
  profileSelectorSource: null,
  profileFallback: null,
  bundle: null,
  bundleSource: null,
}

/**
 * Resolve the winning `profile` selector value across sources, strongest
 * first: `SYSTEMATIC_PROFILE` env var, then custom, then project, then
 * user. The custom and user entries each read their local file first
 * (`custom.local ?? custom`, `user.local ?? user`). The env var outranks every config source, including custom --
 * selection only, it can never supply bundle content. A source's `profile`
 * is considered "set" as soon as it is not `undefined` -- an explicit
 * `null` counts as set and wins outright (it means "base configuration",
 * intentionally, and must not fall through to a weaker source's name). Only
 * a truly absent field (the source doesn't have `profile` at all, or the
 * source itself doesn't exist) falls through to the next candidate. The env
 * var follows the same `?.trim()` pattern as `OPENCODE_CONFIG_DIR`
 * (line ~2253): a blank or whitespace-only value is treated as unset.
 *
 * Returns `null` when no source set `profile` at all (selection table case 1).
 */
function resolveProfileSelector(input: ProfileSelectionInput): {
  value: string | null
  source: ConfigSourceKind | 'environment'
} | null {
  const envProfile = process.env.SYSTEMATIC_PROFILE?.trim()
  if (envProfile) return { value: envProfile, source: 'environment' }

  const { layers } = input
  const candidates: readonly [ConfigSourceKind, string | null | undefined][] = [
    ['custom', lastDefined([layers.custom, layers.customLocal], 'profile')],
    ['project', layers.project?.config.profile],
    ['user', lastDefined([layers.user, layers.userLocal], 'profile')],
  ]
  for (const [source, value] of candidates) {
    if (value !== undefined) return { value, source }
  }
  return null
}

/**
 * Look up a named profile bundle across custom.local, custom
 * (OPENCODE_CONFIG_DIR), user.local, then user, then -- only when the
 * `allow_project_profiles` opt-in is on -- project, in that order. A local
 * file's bundle wins over its sibling's. Custom wins on a name collision with user -- it
 * is the strongest trust level, and there is no security reason to exclude
 * it. Project is checked LAST and only conditionally: this ordering is the
 * entire anti-shadowing mechanism for the opt-in feature -- a user (or
 * custom) bundle of the same name always wins over a project-defined one,
 * so a repository can never silently override a name the user already
 * trusts. Returns the FILE that defined it alongside the bundle --
 * required so `profileEntry`'s `canonicalPath`/`path` point at whichever
 * file actually defined the active bundle, not unconditionally at the user
 * file (a profile defined only in custom config, with no user config file
 * at all, must still resolve and apply).
 */
function lookupProfileBundle(
  input: ProfileSelectionInput,
  name: string,
): { bundle: RawProfileBundle; definingSource: FileConfigSource } | undefined {
  const { layers } = input
  const lookupOrder = [
    layers.customLocal,
    layers.custom,
    layers.userLocal,
    layers.user,
    input.allowProjectProfiles ? layers.project : null,
  ]
  for (const source of lookupOrder) {
    const bundle = source?.config.profiles?.[name]
    if (source && bundle !== undefined) {
      return { bundle, definingSource: source }
    }
  }
  return undefined
}

/**
 * The single fallback candidate name to retry when a selected profile name
 * is missing: the user layer's own `profile` default (`user.local ?? user`). This is the
 * bottom-rung default regardless of which source's SELECTOR failed --
 * `custom` has no independent "default" identity distinct from `user`'s
 * (a `custom`-sourced selector that itself fails has nothing more trusted
 * to fall back to, so it also bottoms out here), and `resolveProfileSelector`
 * guarantees `custom.profile` is `undefined` whenever `project` wins the
 * selector in the first place (custom is checked before project), so
 * `custom.profile` could never provide a genuinely different fallback
 * candidate than `user.profile` in a reachable case. The BUNDLE for this
 * name is looked up via `lookupProfileBundle`, which checks custom's
 * `profiles` map first, so a fallback name that only exists in custom's
 * `profiles` (not user's) is still found.
 */
function trustedDefaultProfileName(
  input: ProfileSelectionInput,
): string | undefined {
  const userDefault = lastDefined(
    [input.layers.user, input.layers.userLocal],
    'profile',
  )
  return typeof userDefault === 'string' ? userDefault : undefined
}

/**
 * Human-readable label for a selector source used in diagnostic warnings.
 * The three config kinds read as `"<kind> config"`; the environment reads
 * as the variable name itself (`SYSTEMATIC_PROFILE`), never `"environment
 * config"` -- there is no config file to name, and conflating the two
 * would contradict `ProfileSelectorSource`'s doc comment distinguishing an
 * env override from a config source.
 */
function selectorSourceLabel(source: ConfigSourceKind | 'environment'): string {
  return source === 'environment' ? 'SYSTEMATIC_PROFILE' : `${source} config`
}

/**
 * Resolve which named profile bundle (if any) is active for this load,
 * implementing the selection table from plan
 * 2026-09-04-002-feat-model-config-profiles (Unit 2). The named bundle is
 * looked up across custom, user, and (only when `allow_project_profiles`
 * is on) project `profiles` maps, in that order (`lookupProfileBundle`) --
 * a custom OR user source's `profiles` map is equally eligible regardless
 * of which source supplied the winning selector name; a project source's
 * map is eligible only as the last resort, and only under the opt-in (see
 * `lookupProfileBundle`'s doc comment for why that ordering is the
 * anti-shadowing mechanism). Emits at most one warning per call through
 * `warningSink`.
 */
function resolveActiveProfile(
  input: ProfileSelectionInput,
): ProfileSelectionResult {
  const selection = resolveProfileSelector(input)
  if (selection === null) return NO_PROFILE_SELECTION

  // Explicit null: "base configuration", intentionally. Wins outright, no
  // fallback lookup, no warning.
  if (selection.value === null) {
    return {
      activeProfile: null,
      profileSelectorSource: selection.source,
      profileFallback: null,
      bundle: null,
      bundleSource: null,
    }
  }

  const requested = selection.value
  const requestedLookup = lookupProfileBundle(input, requested)
  if (requestedLookup !== undefined) {
    return {
      activeProfile: requested,
      profileSelectorSource: selection.source,
      profileFallback: null,
      bundle: requestedLookup.bundle,
      bundleSource: requestedLookup.definingSource,
    }
  }

  // Missing name. Try the one distinct trusted-default fallback candidate.
  // For a `custom`- or `user`-sourced selector this always equals `requested`
  // itself (see `trustedDefaultProfileName`'s doc comment) -- already known
  // missing, so there is nothing new to find and no risk of looping.
  const trustedDefault = trustedDefaultProfileName(input)
  const fallbackLookup =
    trustedDefault !== undefined && trustedDefault !== requested
      ? lookupProfileBundle(input, trustedDefault)
      : undefined

  if (fallbackLookup !== undefined && trustedDefault !== undefined) {
    input.warningSink(
      `[systematic] profile "${sanitizeDiagnosticText(requested)}" (selected by ${selectorSourceLabel(selection.source)}) is not defined in \`profiles\`; falling back to your default profile "${sanitizeDiagnosticText(trustedDefault)}". See ${PROFILE_DOCS_URL} for how to define a profile.`,
    )
    return {
      activeProfile: trustedDefault,
      profileSelectorSource: selection.source,
      profileFallback: { requested, usedDefault: trustedDefault },
      bundle: fallbackLookup.bundle,
      bundleSource: fallbackLookup.definingSource,
    }
  }

  const sourceNote =
    selection.source === 'user'
      ? ''
      : ` (selected by ${selectorSourceLabel(selection.source)})`
  const alsoMissingNote =
    trustedDefault !== undefined && trustedDefault !== requested
      ? ` Your default profile "${sanitizeDiagnosticText(trustedDefault)}" is also not defined in \`profiles\`.`
      : trustedDefault === undefined
        ? ' No default profile is configured (`profile` in your user config).'
        : ''
  input.warningSink(
    `[systematic] profile "${sanitizeDiagnosticText(requested)}"${sourceNote} is not defined in \`profiles\`; using base configuration (no profile).${alsoMissingNote} See ${PROFILE_DOCS_URL} for how to define a profile.`,
  )
  return {
    activeProfile: null,
    profileSelectorSource: selection.source,
    profileFallback: { requested, usedDefault: null },
    bundle: null,
    bundleSource: null,
  }
}

export interface LoadConfigOptions {
  /**
   * When false, the project-level config source is not loaded at all — not
   * merged, not trust-stripped, entirely absent from the source chain — and
   * no repository root is looked up. Used by global-scoped pi-subagents
   * export so it never absorbs cwd project overlays (plan R7/R19). Defaults
   * to true, which reads the project file from the repository root above the
   * start directory (see `getConfigPaths`).
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

/** A user-level file that is the project config file, reached at one of the four user-level layers. */
interface AliasedConfigFile {
  readonly layer: UserLevelLayer
  readonly path: string
}

/** Where `loadUserLevelSources` keeps each layer's result. */
const USER_LEVEL_SLOT = {
  user: 'user',
  'user.local': 'userLocal',
  custom: 'custom',
  'custom.local': 'customLocal',
} as const satisfies Record<UserLevelLayer, keyof LayeredSources>

/**
 * The user-level files that canonically resolve to the same file as the
 * project config file, in the order a notice names them: custom, custom.local,
 * user, user.local. Every sibling counts, so a project file that is the
 * `custom.local` file is recognised whether or not a separate `custom` base
 * exists. Empty when nothing aliases or the project file is not loaded.
 */
function resolveAliasedConfigFiles(
  paths: {
    readonly projectConfig: string
    readonly userConfig: string
    readonly userLocalConfig: string
    readonly customConfig?: string
    readonly customLocalConfig?: string
  },
  includeProject: boolean,
): readonly AliasedConfigFile[] {
  if (!includeProject) return []
  const candidates: readonly (readonly [UserLevelLayer, string | undefined])[] =
    [
      ['custom', paths.customConfig],
      ['custom.local', paths.customLocalConfig],
      ['user', paths.userConfig],
      ['user.local', paths.userLocalConfig],
    ]
  const project = resolveConfigSourcePath(paths.projectConfig)
  return candidates.flatMap(([layer, file]) =>
    file !== undefined && resolveConfigSourcePath(file) === project
      ? [{ layer, path: file }]
      : [],
  )
}

/**
 * A warning sink that buffers messages (instead of discarding them) when
 * aliased, so the caller can flush them verbatim if the custom-trust pass
 * of the same file fails -- those stripped fields aren't guaranteed to
 * apply via custom trust then, so the warnings must not be lost. Used for
 * every project-trust protected-field warning (overlay strips and the
 * top-level `profiles`-ignored warning). Under `'throw'` mode a failed
 * custom-trust pass aborts before `emitAliasFailureDiagnostics` runs, so the
 * buffer is intentionally never flushed there. Passes through unchanged
 * when not aliased.
 */
function createAliasStripTracker(
  warningSink: (message: string) => void,
  aliasedFile: AliasedConfigFile | undefined,
): {
  readonly sink: (message: string) => void
  readonly buffered: readonly string[]
} {
  if (aliasedFile === undefined) {
    return { sink: warningSink, buffered: [] }
  }
  const buffered: string[] = []
  return {
    sink: (message: string) => {
      buffered.push(message)
    },
    buffered,
  }
}

/**
 * Determine whether an aliased-load notice (success or buffered-failure) is
 * eligible at all. Every protected field a project source can carry has its
 * own ignored-warning (an overlay strip, `profiles`, or
 * `allow_project_profiles`), so a project pass that stripped anything has
 * buffered something.
 */
function isAliasNoticeEligible(input: {
  readonly aliasedFile: AliasedConfigFile | undefined
  readonly bufferedCount: number
}): boolean {
  return input.aliasedFile !== undefined && input.bufferedCount > 0
}

/**
 * Flush buffered project-trust strip warnings verbatim when the aliased
 * custom-trust pass did NOT also succeed -- those stripped fields are not
 * guaranteed to apply via custom trust, so the warnings must not be lost.
 * Runs immediately after the project pass (its original call site/timing),
 * not deferred, so a later throw elsewhere in the load never swallows them.
 * When both passes succeeded, does nothing here -- see
 * `buildAliasSuccessNotice` for that (deferred) case.
 */
function emitAliasFailureDiagnostics(input: {
  readonly aliasedFile: AliasedConfigFile | undefined
  readonly buffered: readonly string[]
  readonly aliasLoaded: boolean
  readonly projectLoaded: boolean
  readonly warningSink: (message: string) => void
}): void {
  if (
    !isAliasNoticeEligible({
      aliasedFile: input.aliasedFile,
      bufferedCount: input.buffered.length,
    })
  ) {
    return
  }
  if (input.projectLoaded && input.aliasLoaded) return
  for (const message of input.buffered) input.warningSink(message)
}

/**
 * Build (but do not emit) the one-line success notice for an aliased load
 * where both project and custom passes succeeded. The caller MUST NOT
 * invoke the returned emitter until every throw-capable step after the
 * project/custom passes (profile-bundle validation, routing-invariant
 * assertion) has completed -- emitting it earlier would claim stripped
 * fields "apply through the custom-trust pass" for a load that may still
 * throw and never return a config. Returns undefined when not eligible or
 * when the passes did not both succeed (the failure path owns that case).
 */
function buildAliasSuccessNotice(input: {
  readonly aliasedFile: AliasedConfigFile | undefined
  readonly bufferedCount: number
  readonly aliasLoaded: boolean
  readonly projectConfigPath: string
  readonly projectLoaded: boolean
  readonly warningSink: (message: string) => void
}): (() => void) | undefined {
  if (
    !isAliasNoticeEligible({
      aliasedFile: input.aliasedFile,
      bufferedCount: input.bufferedCount,
    }) ||
    !(input.projectLoaded && input.aliasLoaded) ||
    input.aliasedFile === undefined
  ) {
    return undefined
  }
  const { layer, path: aliasedPath } = input.aliasedFile
  const trust = LAYER_TRUST[layer]
  const projectConfigPath = input.projectConfigPath
  const warningSink = input.warningSink
  return () => {
    warningSink(
      `[systematic] project config (${sanitizeDiagnosticText(projectConfigPath)}) and ${layer} config (${sanitizeDiagnosticText(aliasedPath)}) resolve to the same file; protected fields stripped from the project pass (security-overlay fields, \`profiles\`, \`allow_project_profiles\`) apply through the ${trust}-trust pass instead.`,
    )
  }
}

/** Where the removed-settings note lives; the warning links to it. */
const REMOVED_SETTINGS_DOCS_URL =
  'https://fro.bot/systematic/reference/configuration#removed-settings'

/**
 * Warn once per real file and removed key in this load. Keyed on the canonical
 * path, so a user and custom config that are the same file warn once. The
 * value is never read. Uses the raw sink so the project cap and alias notice
 * cannot absorb it.
 */
function warnRemovedKeys(
  sources: readonly FileConfigSource[],
  warningSink: (message: string) => void,
): void {
  const reported = new Set<string>()
  for (const source of sources) {
    for (const key of source.removedKeys) {
      const identity = `${source.canonicalPath}\0${key}`
      if (reported.has(identity)) continue
      reported.add(identity)
      warningSink(
        `[systematic] \`${key}\` in config (${sanitizeDiagnosticText(source.path)}) has been removed and is ignored. Delete it from that file to silence this warning. See ${REMOVED_SETTINGS_DOCS_URL} for details.`,
      )
    }
  }
}

/**
 * A warning function for files that failed to load in `report` mode. It names
 * the file and the error class, never its content, and warns once per real
 * file and error class: a project file aliased to the custom file fails twice
 * and says so once.
 */
function createInvalidFileReporter(
  warningSink: (message: string) => void,
): (filePath: string, code: ConfigSourceErrorCode) => void {
  const reported = new Set<string>()
  return (filePath, code) => {
    const identity = `${resolveConfigSourcePath(filePath)}\0${code}`
    if (reported.has(identity)) return
    reported.add(identity)
    warningSink(
      `[systematic] config file (${sanitizeDiagnosticText(filePath)}) is invalid (${code}) and was not loaded.`,
    )
  }
}

/** The same loaded file, held at another user-level layer. Only the layer and trust differ. */
function reassignLayer(
  loaded: LoadedConfigSource,
  layer: UserLevelLayer,
): LoadedConfigSource {
  const trust = LAYER_TRUST[layer]
  return {
    metadata: { ...loaded.metadata, kind: trust },
    source: loaded.source && { ...loaded.source, layer, trust },
  }
}

interface UserLevelLoad {
  readonly user: LoadedConfigSource
  readonly userLocal: LoadedConfigSource
  readonly custom: LoadedConfigSource
  readonly customLocal: LoadedConfigSource
  readonly allowProjectProfiles: boolean
}

/**
 * Load the four user-level files (`user`, `user.local`, `custom`,
 * `custom.local`) and resolve the effective `allow_project_profiles` opt-in
 * from them (last layer to define it wins; default off). They load ahead of
 * the project file because the project pass needs that opt-in to decide
 * whether to strip `profiles`.
 *
 * Each real file is read once: when the custom directory is the user
 * directory (or a symlink to it), the custom layers reuse the user layers'
 * result, so a diagnostic is not emitted twice. Both layer positions still
 * apply, and one warning names the alias. Neither trust level writes strip
 * warnings, so hoisting these loads above the project pass reorders no other
 * warning. Under `invalidSource: 'throw'`, a file that is also the project
 * file now throws from the custom pass first, so the error names custom as
 * the failing source instead of project; see ARCHITECTURE.md's "Named model
 * profiles" section.
 */
function loadUserLevelSources(
  paths: ReturnType<typeof getConfigPaths>,
  context: Pick<
    ConfigSourceLoadInput,
    'invalidSource' | 'reportInvalid' | 'warningSink'
  >,
): UserLevelLoad {
  const loadedByRealFile = new Map<string, LoadedConfigSource>()
  const load = (
    layer: UserLevelLayer,
    filePath: string | undefined,
  ): LoadedConfigSource => {
    if (filePath === undefined) {
      return {
        metadata: { kind: LAYER_TRUST[layer], presence: 'absent' },
        source: null,
      }
    }
    const realFile = resolveConfigSourcePath(filePath)
    const shared = loadedByRealFile.get(realFile)
    if (shared) return reassignLayer(shared, layer)
    const loaded = loadConfigSource({
      ...context,
      filePath,
      layer,
      allowProjectProfiles: false,
    })
    loadedByRealFile.set(realFile, loaded)
    return loaded
  }

  const user = load('user', paths.userConfig)
  const userLocal = load('user.local', paths.userLocalConfig)
  const custom = load('custom', paths.customConfig)
  const customLocal = load('custom.local', paths.customLocalConfig)
  const allowProjectProfiles =
    lastDefined(
      [user.source, userLocal.source, custom.source, customLocal.source],
      'allow_project_profiles',
    ) ?? DEFAULT_CONFIG.allow_project_profiles
  return { user, userLocal, custom, customLocal, allowProjectProfiles }
}

/**
 * Warn about project files the resolved project config location leaves
 * unread: an `.opencode/` file a repository-root file shadows, and an
 * `.opencode/` file in the start directory when the repository root is
 * elsewhere. Neither file is read.
 */
function emitProjectLocationWarnings(
  paths: ReturnType<typeof getConfigPaths>,
  warningSink: (message: string) => void,
): void {
  if (paths.ignoredProjectConfig !== undefined) {
    warningSink(
      `[systematic] project config (${sanitizeDiagnosticText(paths.projectConfig)}) takes precedence over (${sanitizeDiagnosticText(paths.ignoredProjectConfig)}), which is ignored; the two files are never merged.`,
    )
  }
  if (paths.startDirProjectConfig !== undefined) {
    warningSink(
      startDirProjectWarning(
        paths.startDirProjectConfig,
        paths.projectRoot,
        paths.projectConfig,
        sanitizeDiagnosticText,
      ),
    )
  }
}

/**
 * Build the overlay-merge chain, ordering the active profile bundle by
 * provenance -- extracted from `loadConfigWithSources` to keep its
 * cognitive complexity down. The chain is [advisory project-sourced
 * bundle,] user, [user- or custom-sourced bundle,] user.local, project,
 * custom, custom.local. This ordering IS the advisory-merge guarantee's
 * structural half (see the doc comment at the call site for the full
 * explanation): a user/custom-sourced bundle sits at its historical position
 * (authoritative over user base, and under user.local); a project-sourced
 * bundle sits first (merely advisory -- user base's own merge step then
 * field-merges over it instead of replacing it, see the `layer === 'user'`
 * branch of `resolveOverlayEntryValue`).
 */
function buildOverlaySources(
  profileEntry: ProfileBundleConfigSource | null,
  bundleSourceTrust: ConfigSourceKind | undefined,
  layers: LayeredSources,
): ConfigSource[] {
  const ordered =
    profileEntry !== null && bundleSourceTrust === 'project'
      ? [
          profileEntry,
          layers.user,
          layers.userLocal,
          layers.project,
          layers.custom,
          layers.customLocal,
        ]
      : [
          layers.user,
          profileEntry,
          layers.userLocal,
          layers.project,
          layers.custom,
          layers.customLocal,
        ]
  return ordered.filter((source): source is ConfigSource => source !== null)
}

/**
 * The active profile bundle as a chain entry (plan KTD: "Profile selection is
 * a load-time step between stripping and merging"). It may be defined in any
 * user-level file or -- under the `allow_project_profiles` opt-in -- the
 * project file, so its path mirrors `profileSelection.bundleSource`, the file
 * `lookupProfileBundle` actually found it in. The same merge rules that apply
 * to any other overlay value apply to its content (it may freely set
 * model/variant/opencode/pi; `ProfileOverlaySchema` already restricts it to
 * routing-only fields at parse time) -- see `ProfileBundleConfigSource`'s doc
 * comment for why it is a distinct union member rather than a `trust: 'user'`
 * file source. Gated on `bundleSource` existing (not just `bundle`) so a
 * bundle can never be silently dropped for lack of a defining file to
 * attribute it to; and on `activeProfile` narrowing to `string` so
 * `profileName` never needs a fallback value -- both are guaranteed together
 * whenever `bundle` is set (see `resolveActiveProfile`).
 */
function buildProfileEntry(
  profileSelection: ProfileSelectionResult,
): ProfileBundleConfigSource | null {
  const { bundle, bundleSource, activeProfile } = profileSelection
  if (!bundle || !bundleSource || typeof activeProfile !== 'string') return null
  return {
    kind: 'profile-bundle',
    canonicalPath: bundleSource.canonicalPath,
    path: bundleSource.path,
    config: { agents: bundle.agents, categories: bundle.categories },
    protectedFields: [],
    profileName: activeProfile,
    bundleTrust: bundleSource.trust,
  }
}

type DisabledListKey =
  | 'disabled_agents'
  | 'disabled_commands'
  | 'disabled_skills'

/** The union of a `disabled_*` list across the chain, as a fresh array. */
function unionDisabledList(
  sources: readonly FileConfigSource[],
  key: DisabledListKey,
): string[] {
  return sources.reduce(
    (merged, source) => mergeArraysUnique(merged, source.config[key]),
    mergeArraysUnique(DEFAULT_CONFIG[key], undefined),
  )
}

/** `bootstrap` fields spread in chain order, each file's fields over the ones before it. */
function mergeBootstrap(sources: readonly FileConfigSource[]): BootstrapConfig {
  const merged: BootstrapConfig = { ...DEFAULT_CONFIG.bootstrap }
  for (const source of sources) Object.assign(merged, source.config.bootstrap)
  return merged
}

export function loadConfigWithSources(
  projectDir: string,
  options?: LoadConfigOptions,
): SourceAwareConfigResult {
  const includeProject = options?.includeProject ?? true
  const invalidSource = options?.invalidSource ?? 'throw'
  const paths = getConfigPaths(projectDir, options)
  const warningSink = options?.warningSink ?? console.warn
  const reportInvalid = createInvalidFileReporter(warningSink)

  if (includeProject) emitProjectLocationWarnings(paths, warningSink)

  // If project and custom resolve to the same real file, the project pass
  // still strips and validates as usual, but its per-field strip warnings
  // are buffered rather than emitted immediately. If the custom pass of
  // that SAME file also loads, those fields apply through it via ordinary
  // merge precedence, so the buffered warnings are dropped in favor of one
  // alias summary below; otherwise they are flushed as normal.
  const aliasedFiles = resolveAliasedConfigFiles(paths, includeProject)
  const aliasedFile = aliasedFiles[0]
  const projectStrip = createAliasStripTracker(warningSink, aliasedFile)
  // Shared 20-detail cap (see `createBoundedStripWarningSink`) for every
  // project-trust protected-field warning of this load -- overlay-field
  // strips (below, via `stripProjectSecurityOverlayFields`) AND the
  // top-level `profiles`-ignored warning, so neither can push the other
  // past the budget.
  const boundedProjectStrip = createBoundedStripWarningSink(projectStrip.sink)

  // The user-level files are loaded BEFORE `project` specifically so the
  // effective `allow_project_profiles` opt-in is known ahead of the project
  // parse -- the project pass needs it to decide whether to strip
  // `profiles`. See `loadUserLevelSources` for why hoisting the loads is
  // safe for the alias-buffering machinery below.
  const userLevel = loadUserLevelSources(paths, {
    invalidSource,
    reportInvalid,
    warningSink,
  })
  const { allowProjectProfiles } = userLevel
  // The protected fields apply when any user-level layer reading the project
  // file loaded it.
  const aliasLoaded = aliasedFiles.some(
    ({ layer }) => userLevel[USER_LEVEL_SLOT[layer]].source !== null,
  )

  const project: LoadedConfigSource = includeProject
    ? loadConfigSource({
        filePath: paths.projectConfig,
        layer: 'project',
        invalidSource,
        warningSink: boundedProjectStrip.sink,
        reportInvalid,
        allowProjectProfiles,
      })
    : {
        metadata: { kind: 'project', presence: 'absent' },
        source: null,
      }
  const projectSource = project.source

  // `profiles` and `allow_project_profiles` are protected top-level fields,
  // already stripped from `projectSource.config` -- warn once each so a
  // project author isn't left wondering why the field they set never took
  // effect. Routed through `boundedProjectStrip.sink`, not `warningSink`
  // directly, so both share the same 20-detail cap as the overlay-field
  // strip warnings and so aliasing can buffer/suppress them like those (see
  // `emitAliasFailureDiagnostics`/`buildAliasSuccessNotice`).
  emitTopLevelProtectedFieldWarning(
    projectSource,
    'profiles',
    `\`profiles\` in project config (%PATH%) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored. Its bundles are not selectable even if this project also sets \`profile\`.`,
    boundedProjectStrip.sink,
  )
  emitTopLevelProtectedFieldWarning(
    projectSource,
    'allow_project_profiles',
    `\`allow_project_profiles\` in project config (%PATH%) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
    boundedProjectStrip.sink,
  )

  emitProjectSearchProtectedWarnings(projectSource, boundedProjectStrip.sink)

  const suppressedStripCount = boundedProjectStrip.suppressedCount()
  if (suppressedStripCount > 0) {
    projectStrip.sink(
      `[systematic] ${suppressedStripCount} additional project-config protected-field warning(s) in (${sanitizeDiagnosticText(paths.projectConfig)}) were suppressed.`,
    )
  }

  emitAliasFailureDiagnostics({
    aliasedFile,
    buffered: projectStrip.buffered,
    aliasLoaded,
    projectLoaded: project.source !== null,
    warningSink,
  })
  const emitAliasSuccessNotice = buildAliasSuccessNotice({
    aliasedFile,
    bufferedCount: projectStrip.buffered.length,
    aliasLoaded,
    projectConfigPath: paths.projectConfig,
    projectLoaded: project.source !== null,
    warningSink,
  })

  const layers: LayeredSources = {
    user: userLevel.user.source,
    userLocal: userLevel.userLocal.source,
    project: projectSource,
    custom: userLevel.custom.source,
    customLocal: userLevel.customLocal.source,
  }
  const sources = chainOf(layers)
  warnRemovedKeys(sources, warningSink)

  const warned = new Set<string>()

  // Only the user-level files carry a resolved `search`, merged by the one
  // shared rule (see `mergeSearchSettings`) in layer order. A project's
  // `search.sources` were validated and discarded at load; nothing here reads
  // them.
  const mergedSearch = mergeSearchSettings(
    (['user', 'userLocal', 'custom', 'customLocal'] as const).flatMap(
      (slot) => {
        const source = layers[slot]
        return source?.search && isUserLevelLayer(source.layer)
          ? [{ ...source.search, layer: source.layer }]
          : []
      },
    ),
  )

  assertAllProfileBundlesAreValid(
    [
      layers.user,
      layers.userLocal,
      layers.custom,
      layers.customLocal,
      layers.project,
    ].map((source) => source?.config),
  )

  const profileSelection = resolveActiveProfile({
    layers,
    allowProjectProfiles,
    warningSink,
  })

  const profileEntry = buildProfileEntry(profileSelection)

  // Overlay merging uses the chain with the profile bundle in it; every
  // other merge in this function (pi_subagents, disabled_*, bootstrap,
  // skills_as_commands) uses `sources`, the files alone, since a profile
  // bundle carries no fields outside agents/categories. The observation
  // metadata uses a further view that folds each local file into its
  // sibling's kind (see `foldSiblingSources`).
  //
  // Chain position is provenance-dependent -- see `buildOverlaySources`'s
  // doc comment for the full explanation; this IS the advisory-merge
  // guarantee, expressed structurally rather than as a removable check.
  const overlaySources = buildOverlaySources(
    profileEntry,
    profileSelection.bundleSource?.trust,
    layers,
  )

  const mergedOverlays = mergeOverlaySources(overlaySources)
  const mergedPiSubagentsOverlays = mergePiSubagentsOverlaySources(sources)
  const droppedCategories = Object.keys(mergedOverlays.categories).filter(
    (name) => REMOVED_AGENT_CATEGORIES_SET.has(name),
  )
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

  // Computed here, ahead of the disabled_skills/disabled_commands merges
  // below, so `assertRoutingInvariants` can exclude disabled agents from its
  // walk -- a disabled agent must never block config load on a missing
  // model (see the disabled-agent exclusion comment on `collectRoutingTargets`).
  const mergedDisabledAgents = unionDisabledList(sources, 'disabled_agents')

  assertRoutingInvariants(
    overlays,
    mergedPiSubagentsOverlays,
    new Set(mergedDisabledAgents),
    warningSink,
  )

  const result: SystematicConfig = {
    disabled_skills: unionDisabledList(sources, 'disabled_skills'),
    disabled_agents: mergedDisabledAgents,
    disabled_commands: unionDisabledList(sources, 'disabled_commands'),
    bootstrap: mergeBootstrap(sources),
    agents: overlayValues(overlays.agents),
    categories: overlayValues(overlays.categories),
    pi_subagents: {
      categories: overlayValues(mergedPiSubagentsOverlays.categories),
      agents: overlayValues(mergedPiSubagentsOverlays.agents),
    },
    skills_as_commands:
      lastDefined(sources, 'skills_as_commands') ??
      DEFAULT_CONFIG.skills_as_commands,
    // `allow_project_profiles` is protected (stripped from the project file
    // before this point) so only the user-level files decide it.
    allow_project_profiles: allowProjectProfiles,
    ...(mergedSearch.settings && { search: mergedSearch.settings }),
    ...(mergedSearch.unreadable && { searchUnreadable: true }),
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

  // Every throw-capable step (profile-bundle validation, routing-invariant
  // assertion) has completed by this point without throwing, so it is now
  // safe to emit the deferred aliased-load success notice -- see
  // `buildAliasSuccessNotice`.
  emitAliasSuccessNotice?.()

  return {
    config: effectiveConfig,
    metadata: buildConfigObservationMetadata({
      custom: foldKindMetadata('custom', [
        userLevel.custom.metadata,
        userLevel.customLocal.metadata,
      ]),
      profileSelection,
      project: project.metadata,
      sources: foldSiblingSources(sources),
      user: foldKindMetadata('user', [
        userLevel.user.metadata,
        userLevel.userLocal.metadata,
      ]),
    }),
    overlays,
    piSubagentsOverlays: mergedPiSubagentsOverlays,
    activeProfileSourcePath: profileSelection.bundleSource?.path ?? null,
  }
}

function isUserLevelLayer(layer: ConfigSourceLayer): layer is UserLevelLayer {
  return layer !== 'project'
}

/**
 * A kind's source files seen as one: the observation metadata describes a
 * kind (`user`, `project`, `custom`), not a file, so a local file is folded
 * into its sibling after both are validated. The folded entry keeps the
 * canonical path of every file that loaded, so a project file that is the
 * local file (or the base file) is recognised as the same file as the kind,
 * and lists every config in the kind so a field counts as defined when either
 * file defines it.
 */
interface FoldedConfigSource {
  readonly trust: ConfigSourceKind
  readonly canonicalPaths: readonly string[]
  readonly configs: readonly RawSystematicConfig[]
  readonly protectedFields: readonly ConfigProtectedFieldMetadata[]
}

function foldSiblingSources(
  sources: readonly FileConfigSource[],
): FoldedConfigSource[] {
  const byTrust = new Map<ConfigSourceKind, FileConfigSource[]>()
  for (const source of sources) {
    byTrust.set(source.trust, [...(byTrust.get(source.trust) ?? []), source])
  }
  return Array.from(byTrust.values(), (files) => ({
    trust: files[0]?.trust ?? 'user',
    canonicalPaths: files.map((file) => file.canonicalPath),
    configs: files.map((file) => file.config),
    protectedFields: files.flatMap((file) => file.protectedFields),
  }))
}

/** A kind is invalid if either of its files is, present if either exists, else absent. */
function foldKindMetadata(
  kind: ConfigSourceKind,
  files: readonly ConfigSourceMetadata[],
): ConfigSourceMetadata {
  const invalid = files.find((file) => file.presence === 'invalid')
  if (invalid) return invalid
  return files.some((file) => file.presence === 'present')
    ? { kind, presence: 'present' }
    : { kind, presence: 'absent' }
}

interface ConfigSourceLoadSummary {
  readonly custom: ConfigSourceMetadata
  readonly profileSelection: ProfileSelectionResult
  readonly project: ConfigSourceMetadata
  readonly sources: readonly FoldedConfigSource[]
  readonly user: ConfigSourceMetadata
}

function buildConfigObservationMetadata(
  summary: ConfigSourceLoadSummary,
): ConfigObservationMetadata {
  const authorities: ConfigAuthorityMetadata[] = []
  const sourceConfigs = new Map<
    ConfigSourceKind,
    readonly RawSystematicConfig[]
  >()
  const sourcePaths = new Map<ConfigSourceKind, readonly string[]>()
  for (const source of summary.sources) {
    sourceConfigs.set(source.trust, source.configs)
    sourcePaths.set(source.trust, source.canonicalPaths)
  }

  const firstDefinedSource = (
    fieldPath: ConfigAuthorityFieldPath,
    candidates: readonly ConfigSourceKind[],
  ): ConfigAuthorityMetadata | undefined => {
    for (const sourceKind of candidates) {
      const configs = sourceConfigs.get(sourceKind)
      if (configs?.some((config) => hasConfigField(config, fieldPath))) {
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
  }
  for (const fieldPath of CONFIG_AUTHORITY_FIELD_PATHS) {
    const authority = firstDefinedSource(fieldPath, fieldCandidates[fieldPath])
    if (authority) authorities.push(authority)
  }

  const protectedFields = collectVisibleProtectedFields(summary.sources)
  const sources = dedupeSourceMetadata(
    [summary.custom, summary.project, summary.user],
    sourcePaths,
  )
  return {
    authorities: sortAuthorities(authorities),
    protectedFields: sortProtectedFields(protectedFields),
    sources,
    activeProfile: summary.profileSelection.activeProfile,
    profileSelectorSource: summary.profileSelection.profileSelectorSource,
    profileFallback: summary.profileSelection.profileFallback,
  }
}

/**
 * `collectProjectProtectedFields` records a "blocked" entry for every
 * project-trust field this load stripped, unconditionally -- it runs before
 * the custom pass even starts (see the call site in `loadConfigSource`) and
 * has no way to know whether a same-file custom-trust load will later apply
 * those exact fields anyway (see `resolveAliasedCustomConfigPath` /
 * `emitAliasFailureDiagnostics`/`buildAliasSuccessNotice`, which already handle this for the warning-text
 * side of aliasing). When the project and custom configs are the *same*
 * canonical file and the custom-trust pass of that file loaded successfully,
 * the stripped fields DID take effect -- through the custom pass, at full
 * trust -- so reporting them as "blocked" in `ConfigObservationMetadata` is
 * misleading duplication. The same holds for any user-level file that loaded
 * (`user`, `user.local`, `custom` or `custom.local`): a user-level layer
 * applies what a project strips. Drop the project source's protected-field
 * records in that case; keep them (they are genuinely blocked) whenever no
 * loaded user-level file is the project file, or the one that is failed to
 * load (`report` mode).
 */
function collectVisibleProtectedFields(
  sources: readonly FoldedConfigSource[],
): readonly ConfigProtectedFieldMetadata[] {
  const projectSource = sources.find((source) => source.trust === 'project')
  const userLevelPaths = new Set(
    sources
      .filter((source) => source.trust !== 'project')
      .flatMap((source) => source.canonicalPaths),
  )
  const projectAppliedViaUserLevel =
    projectSource?.canonicalPaths.some((file) => userLevelPaths.has(file)) ??
    false

  return sources.flatMap((source) =>
    projectAppliedViaUserLevel && source.trust === 'project'
      ? []
      : source.protectedFields,
  )
}

/**
 * One row per real file. A kind's row is left out only when it adds nothing:
 * every file that loaded in the kind was already reported by a higher-priority
 * kind (the same file reached twice), and the row is not `invalid`. A kind
 * with a file of its own keeps its row, and an `invalid` row is always kept,
 * so a file shared with another kind never hides the failure or the presence
 * of a different file in this one. A user-level kind outranks `project`, so a
 * project file that is a user-level file is reported as that user-level kind.
 * Rows keep their given order.
 */
function dedupeSourceMetadata(
  metadata: readonly ConfigSourceMetadata[],
  sourcePaths: ReadonlyMap<ConfigSourceKind, readonly string[]>,
): readonly ConfigSourceMetadata[] {
  const priority: readonly ConfigSourceKind[] = ['custom', 'user', 'project']
  const seen = new Set<string>()
  const kept = new Set<ConfigSourceKind>()
  for (const kind of priority) {
    const files = sourcePaths.get(kind) ?? []
    const presence = metadata.find((source) => source.kind === kind)?.presence
    const redundant =
      files.length > 0 &&
      files.every((file) => seen.has(file)) &&
      presence !== 'invalid'
    if (redundant) continue
    for (const file of files) seen.add(file)
    kept.add(kind)
  }
  return metadata.filter((source) => kept.has(source.kind))
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

/**
 * Whether a bundled persona is disabled by config, for harnesses that filter
 * after building their persona list (Pi's delegate catalog and the
 * pi-subagents export).
 *
 * The persona is disabled when its bare key or its qualified `category/key`
 * id is in `disabledAgents` (the merged `disabled_agents` list), or when an
 * agent overlay under either of those keys sets `disable: true`. Matching is
 * on the file stem and the category, never on the frontmatter name.
 *
 * Either overlay key disables. OpenCode rejects a config that overlays one
 * persona under both keys, so only a config OpenCode would not load can reach
 * the case where they disagree; disabling is the fail-safe reading.
 *
 * OpenCode applies the same rule inline in `config-handler.ts` and
 * `agent-overlays.ts` over resolved data; `tests/unit/disable-parity.test.ts`
 * pins the two together.
 */
export function isAgentDisabled(
  disabledAgents: ReadonlySet<string>,
  agentOverlays: SourcedOverlayConfigMap['agents'],
  category: string,
  key: string,
): boolean {
  const qualifiedId = category ? `${category}/${key}` : key
  if (disabledAgents.has(key) || disabledAgents.has(qualifiedId)) return true
  return (
    agentOverlays[key]?.value.disable === true ||
    agentOverlays[qualifiedId]?.value.disable === true
  )
}

/**
 * Enumerate every routing-resolver target implied by the merged overlays:
 * every raw agent-overlay key that resolves to a real bundled agent (bare or
 * qualified `category/key`), plus every bundled agent whose category has a
 * category overlay (R3b's "categories are not checked in isolation" --
 * `categories.review.variant` with no category model is fine as long as
 * every agent in `review` resolves its own model, so every agent in an
 * overlaid category must be walked, not just the category itself).
 *
 * A raw overlay key that does not resolve to any known bundled agent (e.g.
 * an unrestricted `profiles.<name>.agents.<key>` entry naming something that
 * isn't a real bundled agent) is silently skipped here -- it is not a valid
 * routing target and this check has no stronger claim to make about it than
 * schema validation already does elsewhere.
 *
 * A disabled agent (see {@link isAgentDisabled}) is excluded from the
 * result. A disabled agent is never emitted to OpenCode at all, so it must
 * never block config load over a routing invariant it can't violate in
 * practice.
 */
export function collectRoutingTargets(
  overlays: SourcedOverlayConfigMap,
  disabledAgents: ReadonlySet<string> = new Set(),
): RoutingTarget[] {
  const targets = new Map<string, RoutingTarget>()

  const addTarget = (agentKey: string, category: string): void => {
    if (isAgentDisabled(disabledAgents, overlays.agents, category, agentKey)) {
      return
    }
    targets.set(`${category}/${agentKey}`, { agentKey, category })
  }

  for (const rawKey of Object.keys(overlays.agents)) {
    const separatorIndex = rawKey.indexOf('/')
    if (separatorIndex === -1) {
      const category = BUNDLED_AGENT_CATEGORY_BY_KEY.get(rawKey)
      if (category !== undefined) addTarget(rawKey, category)
      continue
    }
    const category = rawKey.slice(0, separatorIndex)
    const agentKey = rawKey.slice(separatorIndex + 1)
    if (BUNDLED_AGENT_CATEGORY_BY_KEY.get(agentKey) === category) {
      addTarget(agentKey, category)
    }
  }

  for (const categoryKey of Object.keys(overlays.categories)) {
    const agentKeys = BUNDLED_AGENT_KEYS_BY_CATEGORY.get(categoryKey)
    if (agentKeys === undefined) continue
    for (const agentKey of agentKeys) addTarget(agentKey, categoryKey)
  }

  return Array.from(targets.values())
}

/**
 * Validate that every `categories` key inside a profile bundle names a
 * real bundled agent category -- a typo in a profile is a config error,
 * exactly like a typo in the top-level `categories` overlay is. Only
 * `categories` needs a runtime check: a profile bundle's `agents` field is
 * built by `createProfileBundleSchema` with the exact same enum-object
 * shape as the top-level `agents` field (bare + qualified bundled agent
 * names), so an unknown agent key is already rejected at PARSE time (a
 * Zod `unrecognized_keys` issue) for every source that may define
 * `profiles` -- there is nothing left for a runtime assert to catch there.
 * The top-level `categories` field, by contrast, is a free-form
 * `z.record(z.string(), ...)` (bundled categories are not enumerated in a
 * static generated list the way qualified agent ids are), so category-key
 * validation for both the top level and profile bundles happens here, at
 * load, using the same static `BUNDLED_AGENT_KEYS_BY_CATEGORY` inventory
 * `collectRoutingTargets` already relies on.
 */
function assertProfileBundleCategoryKeysAreBundledCategories(
  profileName: string,
  bundle: RawProfileBundle,
): void {
  for (const categoryKey of Object.keys(bundle.categories ?? {})) {
    if (!BUNDLED_AGENT_KEYS_BY_CATEGORY.has(categoryKey)) {
      throw new Error(
        `Invalid Systematic config: profiles.${profileName}.categories.${categoryKey} is not a bundled agent category. Valid categories: ${Array.from(BUNDLED_AGENT_KEYS_BY_CATEGORY.keys()).join(', ')}`,
      )
    }
  }
}

/**
 * Validate every profile bundle defined in every source that may define
 * `profiles` (the user-level files and project), regardless of whether that
 * bundle is currently selected. A typo in an unselected profile's category
 * key must fail config load exactly like a typo in the top-level
 * `categories` overlay does, rather than staying silent until some later
 * repository happens to select it -- this applies equally to a project
 * bundle: a malformed bundle in a shared repository is a repository bug
 * that should surface for everyone, not just whoever happens to select it.
 * (Agent-key typos are already caught by schema parsing -- see
 * `createProfileBundleSchema`'s doc comment.) `projectConfig` naturally
 * only contributes bundles when `allow_project_profiles` is on -- `profiles`
 * is stripped from it otherwise (see `stripProjectProtectedFields`), so
 * the project config's `profiles` is `undefined` in the opt-in-off case and this
 * loop needs no separate opt-in check of its own. Callers pass the configs in
 * check order: user, user.local, custom, custom.local, project.
 */
function assertAllProfileBundlesAreValid(
  configs: readonly (RawSystematicConfig | undefined)[],
): void {
  for (const config of configs) {
    for (const [profileName, bundle] of Object.entries(
      config?.profiles ?? {},
    )) {
      assertProfileBundleCategoryKeysAreBundledCategories(profileName, bundle)
    }
  }
}

/**
 * Post-merge qualifier-requires-model check (R3b), run once per
 * `loadConfigWithSources` call immediately after the merged overlays exist.
 * Walks every target `collectRoutingTargets` finds, resolves it on the
 * `opencode` harness via the shared routing resolver, and throws a config
 * error naming the target when `variant` resolves without a model
 * (`model: null` counts as a model -- it means inherit; only `undefined`,
 * meaning no layer set a model at all, is the violation). Only `opencode`
 * is resolved here: Pi's `thinking` is independent of `model` by design
 * (`qualifierResolvesWithoutModel` always returns `false` for `harness:
 * 'pi'`), so resolving Pi in this loop could never throw. Also emits the
 * R5 legacy `pi_subagents.thinking` deprecation warnings, collected
 * directly from the written `pi_subagents` overlays
 * (`collectWrittenLegacyPiSubagentsThinkingWarnings`) rather than from any
 * per-agent resolution -- one warning per field the user actually wrote,
 * regardless of how many agents a category-level write resolves for.
 */
function assertRoutingInvariants(
  overlays: SourcedOverlayConfigMap,
  piSubagentsOverlays: SourcedOverlayConfigMap,
  disabledAgents: ReadonlySet<string>,
  warningSink: (message: string) => void,
): void {
  const targets = collectRoutingTargets(overlays, disabledAgents)

  for (const target of targets) {
    const resolution = resolveRouting({
      overlays,
      piSubagentsOverlays,
      target,
      harness: 'opencode',
    })

    if (qualifierResolvesWithoutModel(resolution)) {
      throw new Error(
        `Invalid Systematic config: agents.${target.agentKey}.variant resolves to "${resolution.qualifier}" on the opencode harness, but no model resolves for agents.${target.agentKey} on opencode at any layer (agent, category, block, or flat). Set a model at the same layer or a lower one, or remove the qualifier.`,
      )
    }
  }

  for (const warning of collectWrittenLegacyPiSubagentsThinkingWarnings(
    piSubagentsOverlays,
  )) {
    warningSink(warning)
  }
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
    // A profile-supplied overlay is prefixed with `profiles.<name>.` so a
    // downstream validation error (`validateExactAgentOverlays`,
    // `validateCategoryOverlays`) that ends up blaming this key names the
    // profile bundle and its defining file, not a bare `agents.<key>` path
    // that looks like it came from the top level.
    const keyPath =
      source.kind === 'profile-bundle'
        ? `profiles.${source.profileName}.${mapKey}.${key}`
        : `${mapKey}.${key}`
    if (!isRecord(value)) {
      throwInvalidOverlay(source.path, keyPath)
    }

    // Project-trust security fields were already stripped pre-validation -- see `stripProjectSecurityOverlayFields`.
    const previous = target[key]
    const nextValue = resolveOverlayEntryValue(previous?.value, value, source)
    const nextOrigins = resolveOverlayEntryOrigin(
      previous?.origins,
      value,
      source,
    )

    target[key] = {
      value: nextValue,
      sourcePath: source.path,
      keyPath,
      origins: nextOrigins,
    }
  }
}

/**
 * The `RoutingValueOrigin` tag for whichever file contributed a value at
 * this merge step -- `ConfigSourceKind` verbatim for an ordinary
 * agents/categories overlay entry, or the bundle-trust-qualified
 * `*-profile` variant for the profile-bundle pseudo-source (see
 * `RoutingValueOrigin`'s doc comment).
 */
function originForSource(source: ConfigSource): RoutingValueOrigin {
  if (source.kind === 'profile-bundle') {
    return `${source.bundleTrust}-profile` as const
  }
  return source.trust
}

/**
 * Build a `RoutingFieldOrigins` fragment from the raw (pre-merge) overlay
 * fragment a single source contributed at this key -- one leaf per routing
 * field the fragment sets as an OWN property, tagged with `tag`. A field
 * absent from `fragment` (including a whole missing `opencode`/`pi` block)
 * produces no leaf at all, so spreading this over a `previous` origins
 * fragment (see `resolveOverlayEntryOrigin`) never clobbers an inherited
 * leaf with an accidental `undefined`.
 */
function routingOriginsFromOwnFields(
  fragment: OverlayConfig,
  tag: RoutingValueOrigin,
): RoutingFieldOrigins {
  const origins: {
    -readonly [K in keyof RoutingFieldOrigins]?: RoutingValueOrigin
  } = {}
  if (Object.hasOwn(fragment, 'model')) origins.model = tag
  if (Object.hasOwn(fragment, 'variant')) origins.variant = tag
  const opencodeBlock = fragment.opencode
  if (isRecord(opencodeBlock)) {
    if (Object.hasOwn(opencodeBlock, 'model')) origins.opencodeModel = tag
    if (Object.hasOwn(opencodeBlock, 'variant')) origins.opencodeVariant = tag
  }
  const piBlock = fragment.pi
  if (isRecord(piBlock)) {
    if (Object.hasOwn(piBlock, 'model')) origins.piModel = tag
    if (Object.hasOwn(piBlock, 'thinking')) origins.piThinking = tag
  }
  return origins
}

/**
 * The origins-tracking counterpart to `resolveOverlayEntryValue` -- same
 * per-key policy switch, kept in lockstep so a routing field's recorded
 * origin is always attached to the value that actually won, never derived
 * after the fact from `sourcePath` (see `SourcedOverlayConfig.origins`'s
 * doc comment for the trap this avoids).
 *
 * The three VALUE-level preserving strategies
 * (`mergeProfileOverlayValue` for a profile-bundle source or a user
 * overlay merging over an advisory project bundle; `preserveSecurityFields`
 * for a project-trust source) differ from each other in general -- but for
 * ONLY the six routing leaves this type tracks, all three reduce to the
 * same rule: a leaf `own` sets wins, a leaf `own` doesn't set inherits
 * `previous`. (`preserveSecurityFields`'s project-trust case is exactly
 * this already, since `own` is always empty there -- a project-trust
 * fragment can never own-set `model`/`variant`/`opencode`/`pi`, already
 * stripped pre-validation.) Only an ordinary custom/user full-replace
 * (`resolveOverlayEntryValue`'s final `return next`) starts fresh from
 * `own` alone, matching that strategy discarding every field `next`
 * doesn't restate.
 */
function resolveOverlayEntryOrigin(
  previous: RoutingFieldOrigins | undefined,
  fragment: OverlayConfig,
  source: ConfigSource,
): RoutingFieldOrigins {
  const own = routingOriginsFromOwnFields(fragment, originForSource(source))
  if (!previous) return own
  const preserves =
    source.kind === 'profile-bundle' ||
    source.layer === 'project' ||
    source.layer === 'user'
  return preserves ? { ...previous, ...own } : own
}

/**
 * Decide the merged overlay value for one agent/category key given the
 * previously-accumulated value (if any) and this source's fragment.
 * Extracted from `mergeOverlayMap` to keep that function's branching
 * shallow -- the three merge strategies (blind project preserve, additive
 * profile merge, wholesale user/custom replace) are each documented at
 * their own definition.
 */
function resolveOverlayEntryValue(
  previous: OverlayConfig | undefined,
  next: OverlayConfig,
  source: ConfigSource,
): OverlayConfig {
  if (!previous) return next
  if (source.kind === 'profile-bundle') {
    return mergeProfileOverlayValue(previous, next)
  }
  if (source.layer === 'project') return preserveSecurityFields(previous, next)
  // `previous` is only ever non-empty here when `source` is the user
  // layer AND an advisory (project-sourced) profile bundle was placed
  // ahead of it in `overlaySources` -- `userSource` is unconditionally the
  // FIRST chain entry in every other case (normal/no active profile,
  // user/custom-sourced active profile), so this branch is unreachable
  // then and `!previous` already returned above. This IS the advisory
  // merge: user's own overlay must win every field it sets while still
  // picking up whatever the project bundle filled in, so it reuses the
  // exact same field-additive `mergeProfileOverlayValue` a normal profile
  // uses over user base -- not a second, parallel traversal.
  if (source.layer === 'user') return mergeProfileOverlayValue(previous, next)
  // Every other layer -- user.local, custom, custom.local -- fully replaces
  // the previous value for the same key. Only the project layer, the
  // user-over-advisory-bundle case (above), and the profile-bundle
  // pseudo-source (mergeProfileOverlayValue) merge field-by-field instead.
  return next
}

/**
 * Strip every present `SECURITY_OVERLAY_FIELDS` member from a project-trust
 * overlay fragment, warning once per offending field, and return the
 * stripped fragment for the caller to merge instead of the raw value. A
 * project config cannot dictate routing (`SECURITY_OVERLAY_FIELDS` is
 * user/custom-only) but that must only drop the offending field, not the
 * whole config load -- see issue #992. Returns `value` unchanged (same
 * reference) when nothing was stripped, so a fragment with no security
 * fields allocates nothing extra.
 */
function stripProjectSecurityOverlay(
  sourcePath: string,
  keyPath: string,
  value: Record<string, unknown>,
  warningSink: (message: string) => void,
): Record<string, unknown> {
  const safeKeyPath = sanitizeDiagnosticText(keyPath)
  const safeSourcePath = sanitizeDiagnosticText(sourcePath)
  let stripped: Record<string, unknown> | undefined
  for (const field of SECURITY_OVERLAY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      stripped ??= { ...value }
      delete stripped[field]
      warningSink(
        `[systematic] \`${safeKeyPath}.${field}\` in project config (${safeSourcePath}) is only valid in user config or OPENCODE_CONFIG_DIR config and has been ignored.`,
      )
    }
  }
  return stripped ?? value
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

/**
 * Harness routing blocks that nest one level deeper and need their own
 * field-level merge when both the base value and the profile fragment set
 * them -- otherwise a profile setting only `pi.thinking` would wipe a base
 * `pi.model` (breaking R3b: a profile may set a qualifier alone when the
 * model resolves from a lower layer, and that lower layer may itself be a
 * block, not only a flat field).
 */
const HARNESS_BLOCK_KEYS = ['opencode', 'pi'] as const

/**
 * Merge an active profile bundle's overlay fragment over the base (or
 * project/custom-merged) value for the same agent/category key.
 *
 * Fully field-additive: every field of `previous` absent from `next` is
 * preserved. This is deliberately DIFFERENT from an ordinary user/custom
 * same-key override, which fully replaces the previous value (see
 * `resolveOverlayEntryValue`). A profile bundle can only ever carry
 * routing fields
 * (`ProfileOverlaySchema` rejects `mode`/`color`/`steps`/`hidden`/`disable`
 * at parse time), so switching which profile is active must never change
 * an agent's visibility, permissions, mode, or existence (R7/R10) --
 * fields the profile is schema-incapable of mentioning must simply survive
 * untouched. A field the profile DOES set always wins, including an
 * explicit `model: null` (a plain object spread already gives this: an own
 * `null` property in `next` overrides `previous`'s value for that key).
 *
 * The `opencode`/`pi` blocks are nested objects, so a flat spread would
 * replace the whole block wholesale when both sides set it, losing whichever
 * sibling field (typically `model`) the profile fragment didn't restate.
 * They get one extra level of the same field-preserving merge.
 */
function mergeProfileOverlayValue(
  previous: OverlayConfig,
  next: OverlayConfig,
): OverlayConfig {
  const result: OverlayConfig = { ...previous, ...next }
  for (const blockKey of HARNESS_BLOCK_KEYS) {
    const previousBlock = previous[blockKey]
    const nextBlock = next[blockKey]
    if (isRecord(previousBlock) && isRecord(nextBlock)) {
      result[blockKey] = { ...previousBlock, ...nextBlock }
    }
  }
  return result
}

const PI_SUBAGENTS_PROTECTED_FIELD_SET = new Set(PI_SUBAGENTS_PROTECTED_FIELDS)

/**
 * Merge `pi_subagents.categories`/`pi_subagents.agents` overlays across
 * config sources, in trust order. Like the portable `SECURITY_OVERLAY_FIELDS`
 * (model/variant/skills/permission on `agents`/`categories`, stripped from
 * raw project config before schema validation in `loadConfigSource` --
 * see `stripProjectSecurityOverlayFields`), the pi_subagents-protected
 * fields (`thinking`, `tools`, `skills`) are silently stripped from
 * project-sourced config before merge — project config simply cannot grant
 * them. `max_turns` is trust-any and passes through unchanged. This mirrors
 * the plan's R18 trust lattice: project cannot grant tools/skills to an
 * exported persona.
 */
function mergePiSubagentsOverlaySources(
  sources: readonly FileConfigSource[],
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
  source: FileConfigSource,
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

type ConfigPathOptions = Pick<
  LoadConfigOptions,
  'customConfigDir' | 'homeDir' | 'includeProject' | 'userConfigDir'
>

/**
 * Where each config file lives.
 *
 * The project file is read from the repository root: the nearest ancestor of
 * `projectDir` holding `.git`, or `projectDir` itself when there is none (kept
 * as given, not resolved). Under that root `.systematic.jsonc` (else
 * `.systematic.json`) wins over `.opencode/systematic.jsonc` (else `.json`);
 * `ignoredProjectConfig` names the `.opencode/` file a root file shadows. With
 * `includeProject: false` no root is looked up and `projectConfig` stays under
 * `projectDir`. `startDirProjectConfig` names an `.opencode/` file in
 * `projectDir` that is not read because the root is elsewhere.
 *
 * The local files sit beside the user and custom files and are selected even
 * when absent. `customAliasesUser` is true when the custom directory is the
 * user directory.
 */
export function getConfigPaths(
  projectDir: string,
  options?: ConfigPathOptions,
) {
  const dirs = resolveUserLevelConfigDirs(options)
  const { homeDir, customConfigDir } = dirs
  const selection = selectUserLevelConfigFiles(dirs)
  const fileFor = (layer: UserLevelLayer): string | undefined =>
    selection.files.find((file) => file.layer === layer)?.path
  const userFile = (layer: 'user' | 'user.local'): string => {
    const file = fileFor(layer)
    if (file === undefined) {
      throw new Error(`No ${layer} config file was selected`)
    }
    return file
  }

  const repoRoot =
    (options?.includeProject ?? true) ? lookupSearchRoot(projectDir) : undefined
  const projectRoot = repoRoot?.root ?? projectDir
  const project = repoRoot
    ? selectProjectConfigFile(projectRoot)
    : {
        path: selectConfigFile(
          path.join(projectDir, '.opencode'),
          'systematic',
        ),
      }
  const startDirProjectConfig = repoRoot
    ? findStartDirProjectConfig(projectDir, repoRoot, project.path)
    : undefined
  const ignoredProjectConfig =
    'ignoredPath' in project ? project.ignoredPath : undefined
  const customConfig = fileFor('custom')
  const customLocalConfig = fileFor('custom.local')

  return {
    userConfig: userFile('user'),
    userLocalConfig: userFile('user.local'),
    projectConfig: project.path,
    projectRoot,
    userDir: path.join(homeDir, '.config/opencode/systematic'),
    projectDir: path.join(projectRoot, '.opencode/systematic'),
    customAliasesUser: selection.aliased,
    ...(ignoredProjectConfig !== undefined && { ignoredProjectConfig }),
    ...(startDirProjectConfig !== undefined && { startDirProjectConfig }),
    ...(customConfigDir &&
      customConfig !== undefined &&
      customLocalConfig !== undefined && {
        customConfig,
        customLocalConfig,
        customDir: path.join(customConfigDir, 'systematic'),
      }),
  }
}
