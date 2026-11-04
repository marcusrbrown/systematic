/**
 * The per-call reader behind `kind: "external"`: it turns the user config
 * files, the project config file and the project's identity into the ordered
 * list of active sources for one call.
 *
 * Import rule: this module may import only node builtins, `search-corpus.ts`
 * (for the checkout root walk), `search-project-identity.ts` and
 * `search-user-config.ts`. It must never import `config.ts` or
 * `config-schema.ts`: the `systematic-search` bin bundles it, and those would
 * drag the whole config loader into that bundle.
 *
 * It holds no state. Every call re-reads the user files (the allow list and
 * the user sources), the project file and the project identity, so editing
 * any of them takes effect on the next call. `search.enabled` is not
 * read here: it is fixed at init by each surface and never changes per call.
 *
 * Resolution order: proposals of a project that is not allowed are
 * dropped, a user source mapped to this project shadows a same-named project
 * source, user sources come before project sources, and the list caps at
 * `MAX_ACTIVE_SOURCES`. Project-source problems never throw and never touch
 * built-in replies; the caller decides how to word the states. A project that
 * is not allowed forwards no warning that names one of its entries: its
 * replies name no proposal, and `inspectSearch` is where those warnings go.
 *
 * Roots come back resolved to absolute paths and nothing more: existence,
 * symlink and containment checks belong to the loader that reads them.
 */

import os from 'node:os'
import path from 'node:path'
import {
  type DocumentKind,
  discoverSourceFiles,
  isDocumentKind,
  KIND_TABLE,
  lookupSearchRoot,
  PROJECT_ROOT_REJECTION_REASONS,
  type ProjectRootRejection,
  rejectedProjectRoot,
  resolveSearchRoot,
  safeLstat,
} from './search-corpus.js'
import {
  isAllowedProject,
  type ProjectIdentity,
  resolveProjectIdentity,
} from './search-project-identity.js'
import {
  type DroppedSearchEntry,
  findStartDirProjectConfig,
  loadProjectSearchSources,
  loadUserLevelSearchSettings,
  type ProjectSearchLoad,
  resolveUserLevelConfigDirs,
  type SearchSourceEntry,
  type SearchSourceFormat,
  selectProjectConfigFile,
  startDirProjectWarning,
  type UserLevelConfigDirOptions,
  type UserLevelLayer,
} from './search-user-config.js'

/** At most this many sources are active in one call. */
export const MAX_ACTIVE_SOURCES = 8

/** Names listed in the cap warning before it says how many more were dropped. */
const MAX_LISTED_DROPPED = 8

export type SourceOrigin = 'project' | 'user'

/** One source active for this call, with its roots resolved to absolute paths. */
export interface ActiveSource {
  readonly name: string
  readonly format: SearchSourceFormat
  readonly roots: readonly string[]
  readonly origin: SourceOrigin
  /** Validated exclude patterns for this source's walk. Empty when none. */
  readonly exclude: readonly string[]
}

/**
 * What the project's own config contributed.
 *
 * - `none`: no proposals (no file, no `search` block or no valid entry).
 * - `allowed`: the project is allowed; `proposals` valid entries were considered.
 * - `not-allowed`: the project proposes sources but its main root is not in the
 *   allow list. Carries the proposal count only, never a name or a root, and
 *   the main-root string only when the identity is verified.
 * - `config-unreadable`: the project file had a structural error (a read or
 *   parse error, an oversized file, an invalid container), so it proposes
 *   nothing. Separate from the user-config `config unreadable` note.
 */
export type ProjectState =
  | { readonly kind: 'none' }
  | { readonly kind: 'allowed'; readonly proposals: number }
  | {
      readonly kind: 'not-allowed'
      readonly proposals: number
      readonly mainRoot?: string
    }
  | { readonly kind: 'config-unreadable' }

export interface ExternalSourcesResolution {
  /** Active sources in order: user sources, then project sources, at most `MAX_ACTIVE_SOURCES`. */
  readonly sources: readonly ActiveSource[]
  readonly project: ProjectState
  /**
   * The user-level files this call read had a problem that changes what
   * search does: a parse error, a bad allow entry, a non-array
   * `sources`, an unknown key. The caller prints one `config unreadable`
   * note; a repair between calls clears it.
   */
  readonly userConfigUnreadable: boolean
  /**
   * Bounded warnings, the source-cap warning first, then user-file
   * and project-file warnings. They name fields and source names, never a
   * value. Each file's own list is bounded by its validator, and each file is
   * read once per call, so it reports a problem once.
   */
  readonly warnings: readonly string[]
  /**
   * The source entries the validators dropped whole, apart by where they were
   * declared: the user-level files, and the project file.
   */
  readonly dropped: {
    readonly user: readonly DroppedSearchEntry[]
    readonly project: readonly DroppedSearchEntry[]
  }
}

export interface ExternalSourcesInput {
  /** The directory the checkout-root walk-up starts from. */
  readonly startDir: string
  /** Config directory resolution, as the other user-level readers take it. Defaults to the home directory and `OPENCODE_CONFIG_DIR`. */
  readonly configOptions?: UserLevelConfigDirOptions | undefined
  /** Override the identity of the checkout. Tests use this; surfaces leave it out. */
  readonly identity?: ProjectIdentity | undefined
}

/** `~` and `~/...` (or `~\...`) against `homeDir`; anything else is returned as given. */
function expandHome(root: string, homeDir: string): string {
  if (root === '~') return homeDir
  if (root.startsWith('~/') || root.startsWith('~\\')) {
    return path.join(homeDir, root.slice(2))
  }
  return root
}

function capWarning(dropped: readonly ActiveSource[]): string {
  const listed = dropped.slice(0, MAX_LISTED_DROPPED).map((s) => s.name)
  const more = dropped.length - listed.length
  const names = `${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  return `[systematic] more than ${MAX_ACTIVE_SOURCES} search sources are active for this project; these were dropped: ${names}. Remove a source or narrow its \`projects\` to bring the count down.`
}

/**
 * User sources mapped to this project, in merged order (user file, then
 * custom dir). The validator guarantees every user entry has `projects`; the
 * `undefined` check only narrows the type.
 */
function mappedUserEntries(
  declared: readonly SearchSourceEntry[],
  identity: ProjectIdentity,
  homeDir: string,
): SearchSourceEntry[] {
  return declared.filter(
    (entry) =>
      entry.projects !== undefined &&
      isAllowedProject(identity, entry.projects, { homeDir }),
  )
}

function userSourceOf(entry: SearchSourceEntry, homeDir: string): ActiveSource {
  return {
    name: entry.name,
    format: entry.format,
    roots: entry.roots.map((root) => expandHome(root, homeDir)),
    origin: 'user',
    exclude: entry.exclude ?? [],
  }
}

function mappedUserSources(
  declared: readonly SearchSourceEntry[],
  identity: ProjectIdentity,
  homeDir: string,
): ActiveSource[] {
  return mappedUserEntries(declared, identity, homeDir).map((entry) =>
    userSourceOf(entry, homeDir),
  )
}

/** A project proposal as a source, its roots resolved against the checkout root. */
function projectSourceOf(
  entry: SearchSourceEntry,
  checkoutRoot: string,
): ActiveSource {
  return {
    name: entry.name,
    format: entry.format,
    roots: entry.roots.map((root) => path.resolve(checkoutRoot, root)),
    origin: 'project',
    exclude: entry.exclude ?? [],
  }
}

/**
 * Project proposals as sources. A proposal whose name a mapped user source
 * holds is left out: the merge keeps only the user source.
 */
function projectSourcesOf(
  proposals: readonly SearchSourceEntry[],
  checkoutRoot: string,
  shadowed: ReadonlySet<string>,
): ActiveSource[] {
  return proposals
    .filter((entry) => !shadowed.has(entry.name))
    .map((entry) => projectSourceOf(entry, checkoutRoot))
}

/**
 * The project warnings a reply may carry. A project that is not allowed has
 * no say in what the reply names, so the warnings about its entries stay out.
 */
function forwardedProjectWarnings(
  project: ProjectSearchLoad,
  projectAllowed: boolean,
): readonly string[] {
  if (projectAllowed) return project.warnings
  const aboutEntries = new Set(
    project.entries.flatMap((entry) => entry.warnings),
  )
  return project.warnings.filter((warning) => !aboutEntries.has(warning))
}

/**
 * The warning for the start directory's own project file when the checkout
 * root is elsewhere, under the condition the config loader warns under.
 */
function startDirWarnings(
  startDir: string,
  lookup: ReturnType<typeof lookupSearchRoot>,
  checkoutRoot: string,
): string[] {
  const selected = selectProjectConfigFile(checkoutRoot).path
  const ignored = findStartDirProjectConfig(startDir, lookup, selected)
  return ignored === undefined
    ? []
    : [startDirProjectWarning(ignored, checkoutRoot, selected)]
}

/**
 * Read everything for one `external` call and resolve the active sources.
 * Never throws: every file problem is a state or a warning.
 */
export function resolveExternalSources(
  input: ExternalSourcesInput,
): ExternalSourcesResolution {
  const dirs = resolveUserLevelConfigDirs(input.configOptions)
  const homeDir = dirs.homeDir || os.homedir()
  const lookup = lookupSearchRoot(input.startDir)
  const checkoutRoot = lookup.foundGit
    ? lookup.root
    : resolveSearchRoot(input.startDir)
  const identity = input.identity ?? resolveProjectIdentity(checkoutRoot)

  const user = loadUserLevelSearchSettings(input.configOptions)
  const allow = user.settings?.allow_project_sources ?? []
  const project = loadProjectSearchSources(checkoutRoot)
  const projectAllowed = isAllowedProject(identity, allow, { homeDir })

  const userSources = mappedUserSources(
    user.settings?.sources ?? [],
    identity,
    homeDir,
  )

  let projectState: ProjectState
  let projectSources: ActiveSource[] = []
  const proposals = project.sources.length
  if (project.unreadable) {
    projectState = { kind: 'config-unreadable' }
  } else if (proposals === 0) {
    projectState = { kind: 'none' }
  } else if (projectAllowed) {
    projectState = { kind: 'allowed', proposals }
    projectSources = projectSourcesOf(
      project.sources,
      checkoutRoot,
      new Set(userSources.map((source) => source.name)),
    )
  } else {
    projectState =
      identity.status === 'resolved'
        ? { kind: 'not-allowed', proposals, mainRoot: identity.mainRoot }
        : { kind: 'not-allowed', proposals }
  }

  const ordered = [...userSources, ...projectSources]
  const sources = ordered.slice(0, MAX_ACTIVE_SOURCES)
  const capped = ordered.slice(MAX_ACTIVE_SOURCES)
  return {
    sources,
    project: projectState,
    userConfigUnreadable: user.unreadable,
    warnings: [
      ...(capped.length > 0 ? [capWarning(capped)] : []),
      ...user.warnings,
      ...startDirWarnings(input.startDir, lookup, checkoutRoot),
      ...forwardedProjectWarnings(project, projectAllowed),
    ],
    dropped: { user: user.dropped, project: project.dropped },
  }
}

// ── Inspection ──────────────────────────────────────────────────────────────

/** Where an inspected source was declared. A dropped user-level entry reports `user`: its file is not tracked. */
export type InspectedSourceOrigin = UserLevelLayer | 'project'

export type InspectedSourceStatus =
  | 'active'
  | 'not allowed'
  | 'over source cap'
  | 'missing root'

/**
 * One root of a source. `present` is the result of one `lstat`; it is `null`
 * for a source that is not in this call's active list, whose roots are not
 * touched.
 */
export interface InspectedRoot {
  readonly path: string
  readonly present: boolean | null
}

export type InspectedSource =
  | {
      readonly status: InspectedSourceStatus
      readonly name: string
      readonly origin: InspectedSourceOrigin
      readonly format: SearchSourceFormat
      readonly roots: readonly InspectedRoot[]
      readonly exclude: readonly string[]
      /** Warnings that name this source. They never carry a pattern. */
      readonly warnings: readonly string[]
    }
  | {
      /**
       * A project root the loader refuses (a symlink, a path through a
       * symlink, or a real path outside the checkout): the source is dropped
       * when a search loads it. `reason` says which.
       */
      readonly status: 'root rejected'
      readonly name: string
      readonly origin: 'project'
      readonly format: SearchSourceFormat
      readonly roots: readonly InspectedRoot[]
      readonly exclude: readonly string[]
      readonly reason: string
      readonly warnings: readonly string[]
    }
  | {
      readonly status: 'dropped invalid'
      /** The source name, or `#<index>` when the entry had no usable name. */
      readonly name: string
      readonly origin: 'user' | 'project'
      readonly reason: string
      readonly warnings: readonly string[]
    }

export type BuiltInKindState = 'present' | 'empty' | 'missing' | 'unreadable'

export interface InspectedBuiltInKind {
  readonly kind: DocumentKind
  /** Absolute directory the kind is read from. */
  readonly directory: string
  readonly state: BuiltInKindState
}

export interface SearchInspection {
  /** False only when a user-level file sets `search.enabled: false`. */
  readonly enabled: boolean
  readonly allowProjectSources: readonly string[]
  /** Whether this project's main root is on the allow list. */
  readonly projectAllowed: boolean
  /** The checkout root the project file, project roots and built-in kinds are read from. */
  readonly projectRoot: string
  readonly userConfigUnreadable: boolean
  readonly projectConfigUnreadable: boolean
  /** Sources in resolution order, then not-allowed proposals, then dropped entries. */
  readonly sources: readonly InspectedSource[]
  readonly builtIn: readonly InspectedBuiltInKind[]
  /** Warnings from the config files that name no listed source. */
  readonly warnings: readonly string[]
}

export interface SearchInspectionInput {
  /** The checkout root, as the caller shows it elsewhere. Not resolved again. */
  readonly checkoutRoot: string
  readonly configOptions?: UserLevelConfigDirOptions | undefined
  /** Override the identity of the checkout. Tests use this; surfaces leave it out. */
  readonly identity?: ProjectIdentity | undefined
}

function inspectBuiltInKinds(checkoutRoot: string): InspectedBuiltInKind[] {
  return Object.keys(KIND_TABLE)
    .filter(isDocumentKind)
    .map((kind) => {
      const spec = KIND_TABLE[kind]
      const directory = path.join(checkoutRoot, ...spec.dir.split('/'))
      const discovery = discoverSourceFiles(
        {
          directory,
          containedIn: checkoutRoot,
          walk: spec,
          label: spec.dir,
        },
        [],
      )
      // A directory that resolves outside the checkout is not loaded, which an
      // unreadable one is not either.
      const state: BuiltInKindState =
        discovery.state === 'found'
          ? discovery.candidates.length > 0
            ? 'present'
            : 'empty'
          : discovery.state === 'missing'
            ? 'missing'
            : 'unreadable'
      return { kind, directory, state }
    })
}

/** A source with the validated entry it came from, so its own warnings can be found. */
interface Declared {
  readonly source: ActiveSource
  readonly entry: SearchSourceEntry
}

/** The first rejection among a project source's roots, the one that drops the source. */
function firstRootRejection(
  checkoutRoot: string,
  roots: readonly string[],
): ProjectRootRejection | undefined {
  for (const root of roots) {
    const rejection = rejectedProjectRoot(checkoutRoot, root)
    if (rejection !== undefined) return rejection
  }
  return undefined
}

/**
 * Describe what search does for one project, without running a search: which
 * sources exist, where each came from, and why each is or is not active.
 *
 * It reads the same files through the same readers and applies the same
 * order as `resolveExternalSources`, then adds what that result leaves out:
 * the declaring layer, the cap, one `lstat` per root of each source in the
 * active list, and the names and roots of proposals the allow list rejects.
 * No external root is walked and no document is read; the built-in kinds are
 * listed by directory only. Never throws.
 */
export function inspectSearch(input: SearchInspectionInput): SearchInspection {
  const { checkoutRoot } = input
  const dirs = resolveUserLevelConfigDirs(input.configOptions)
  const homeDir = dirs.homeDir || os.homedir()
  const identity = input.identity ?? resolveProjectIdentity(checkoutRoot)

  const user = loadUserLevelSearchSettings(input.configOptions)
  const allow = user.settings?.allow_project_sources ?? []
  const project = loadProjectSearchSources(checkoutRoot)
  const projectAllowed = isAllowedProject(identity, allow, { homeDir })

  const userDeclared: Declared[] = mappedUserEntries(
    user.settings?.sources ?? [],
    identity,
    homeDir,
  ).map((entry) => ({ entry, source: userSourceOf(entry, homeDir) }))
  // A user source holds a same-named allowed proposal's place, but a proposal
  // that is not allowed is listed whatever a user source is called.
  const shadowed = projectAllowed
    ? new Set(userDeclared.map(({ source }) => source.name))
    : new Set<string>()
  const projectDeclared: Declared[] = project.sources
    .filter((entry) => !shadowed.has(entry.name))
    .map((entry) => ({
      entry,
      source: projectSourceOf(entry, checkoutRoot),
    }))
  const ordered = [...userDeclared, ...(projectAllowed ? projectDeclared : [])]
  const rejected = projectAllowed ? [] : projectDeclared
  const loaderRoot = path.resolve(checkoutRoot)

  // Each warning belongs to the declaration that produced it: the entry the
  // validator kept (traced by identity through the merge) or the entry it
  // dropped. A warning of a declaration with no row stays in the section list.
  const outcomes = [...user.entries, ...project.entries]
  const warningsOfKept = new Map<SearchSourceEntry, readonly string[]>()
  for (const outcome of outcomes) {
    if (outcome.kind === 'kept')
      warningsOfKept.set(outcome.entry, outcome.warnings)
  }
  const named = new Set<string>()
  const claim = (warnings: readonly string[]): readonly string[] => {
    for (const warning of warnings) named.add(warning)
    return warnings
  }

  const describe = (
    { source, entry }: Declared,
    status: InspectedSourceStatus | 'checked',
  ): InspectedSource => {
    const roots: InspectedRoot[] = source.roots.map((root) => ({
      path: root,
      present: status === 'checked' ? safeLstat(root) !== null : null,
    }))
    const warnings = claim(warningsOfKept.get(entry) ?? [])
    const rejection =
      status === 'checked' && source.origin === 'project'
        ? firstRootRejection(loaderRoot, source.roots)
        : undefined
    if (rejection !== undefined) {
      return {
        status: 'root rejected',
        name: source.name,
        origin: 'project',
        format: source.format,
        roots,
        exclude: source.exclude,
        reason: PROJECT_ROOT_REJECTION_REASONS[rejection],
        warnings,
      }
    }
    return {
      status:
        status === 'checked'
          ? roots.some((root) => root.present === false)
            ? 'missing root'
            : 'active'
          : status,
      name: source.name,
      origin:
        source.origin === 'project'
          ? 'project'
          : (user.sourceLayers.get(source.name) ?? 'user'),
      format: source.format,
      roots,
      exclude: source.exclude,
      warnings,
    }
  }

  const droppedRows = [
    ...user.entries.map((outcome) => ({ outcome, origin: 'user' as const })),
    ...project.entries.map((outcome) => ({
      outcome,
      origin: 'project' as const,
    })),
  ].flatMap(({ outcome, origin }): InspectedSource[] =>
    outcome.kind === 'dropped'
      ? [
          {
            status: 'dropped invalid',
            name: outcome.label.startsWith('"')
              ? outcome.label.slice(1, -1)
              : outcome.label,
            origin,
            reason: outcome.reason,
            warnings: claim(outcome.warnings),
          },
        ]
      : [],
  )

  const sources: InspectedSource[] = [
    ...ordered.map((declared, index) =>
      describe(
        declared,
        index < MAX_ACTIVE_SOURCES ? 'checked' : 'over source cap',
      ),
    ),
    ...rejected.map((declared) => describe(declared, 'not allowed')),
    ...droppedRows,
  ]

  return {
    enabled: user.settings?.enabled !== false,
    allowProjectSources: allow,
    projectAllowed,
    projectRoot: checkoutRoot,
    userConfigUnreadable: user.unreadable,
    projectConfigUnreadable: project.unreadable,
    sources,
    builtIn: inspectBuiltInKinds(checkoutRoot),
    warnings: [...user.warnings, ...project.warnings].filter(
      (warning) => !named.has(warning),
    ),
  }
}
