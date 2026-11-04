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
 * built-in replies; the caller decides how to word the states.
 *
 * Roots come back resolved to absolute paths and nothing more: existence,
 * symlink and containment checks belong to the loader that reads them.
 */

import os from 'node:os'
import path from 'node:path'
import { resolveSearchRoot } from './search-corpus.js'
import {
  isAllowedProject,
  type ProjectIdentity,
  resolveProjectIdentity,
} from './search-project-identity.js'
import {
  type DroppedSearchEntry,
  loadProjectSearchSources,
  loadUserLevelSearchSettings,
  resolveUserLevelConfigDirs,
  type SearchSourceEntry,
  type SearchSourceFormat,
  type UserLevelConfigDirOptions,
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
function mappedUserSources(
  declared: readonly SearchSourceEntry[],
  identity: ProjectIdentity,
  homeDir: string,
): ActiveSource[] {
  return declared
    .filter(
      (entry) =>
        entry.projects !== undefined &&
        isAllowedProject(identity, entry.projects, { homeDir }),
    )
    .map((entry) => ({
      name: entry.name,
      format: entry.format,
      roots: entry.roots.map((root) => expandHome(root, homeDir)),
      origin: 'user' as const,
      exclude: entry.exclude ?? [],
    }))
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
  const checkoutRoot = resolveSearchRoot(input.startDir)
  const identity = input.identity ?? resolveProjectIdentity(checkoutRoot)

  const user = loadUserLevelSearchSettings(input.configOptions)
  const allow = user.settings?.allow_project_sources ?? []
  const project = loadProjectSearchSources(checkoutRoot)

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
  } else if (isAllowedProject(identity, allow, { homeDir })) {
    projectState = { kind: 'allowed', proposals }
    const shadowed = new Set(userSources.map((source) => source.name))
    projectSources = project.sources
      .filter((entry) => !shadowed.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        format: entry.format,
        roots: entry.roots.map((root) => path.resolve(checkoutRoot, root)),
        origin: 'project' as const,
        exclude: entry.exclude ?? [],
      }))
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
      ...project.warnings,
    ],
    dropped: { user: user.dropped, project: project.dropped },
  }
}
