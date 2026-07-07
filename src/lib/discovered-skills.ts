import fs from 'node:fs'
import path from 'node:path'
import { extractFrontmatter, type SkillFrontmatter } from './skills.js'
import { walkDir } from './walk-dir.js'

/**
 * Provenance ids for discovered skills. When the same skill `name` is found
 * in multiple roots, the winner is whichever root is discovered LAST in
 * upstream's sequence (mirrors upstream `skill/index.ts`'s last-write-wins
 * map keyed by frontmatter name). Discovery order (earliest to latest):
 * global-claude, global-agents, project-claude/project-agents (walked from
 * startDir up to the worktree root, closest-first), then all
 * `.opencode`-style config directories (global-opencode-config wins over
 * everything above it). Do not reorder without re-verifying against
 * upstream.
 */
type DiscoveryRootId =
  | 'global-claude'
  | 'global-agents'
  | 'project-claude'
  | 'project-agents'
  | 'project-opencode'
  | 'global-opencode-config'

export interface DiscoveredSkill {
  name: string
  description: string
  frontmatter: SkillFrontmatter
  skillPath: string
  root: DiscoveryRootId
}

export interface DiscoverSkillsOptions {
  /** Directory to start the upward worktree walk from (typically the project cwd). */
  startDir: string
  /** Home directory, injected so tests can use a temp dir instead of the real one. */
  homeDir: string
  /**
   * Override for OpenCode's global config directory (mirrors
   * `$XDG_CONFIG_HOME` resolution). Defaults to `<homeDir>/.config/opencode`
   * when omitted.
   */
  configDir?: string
  /**
   * Override mirroring upstream's `OPENCODE_CONFIG_DIR` env var: an extra
   * config directory appended to the end of the OpenCode config-dir list
   * (so it wins over every other root, including the default global config
   * dir). Injected as a param rather than read from `process.env` to keep
   * discovery pure and testable.
   */
  opencodeConfigDirOverride?: string
}

/** Upstream skill-name regex: lowercase alphanumeric segments joined by single hyphens, 1-64 chars. */
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_REGEX.test(name)
}

/**
 * Find the git worktree root: the first ancestor of `startDir` (inclusive)
 * containing a `.git` entry. Returns `null` if none exists. Never throws.
 */
function findGitWorktreeRoot(startDir: string): string | null {
  let current = path.resolve(startDir)
  // eslint-disable-next-line no-constant-condition -- bounded by filesystem root
  while (true) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current
      }
    } catch {
      return null // unreadable ancestor: stop walking, never throw
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Mirrors upstream `FSUtil.up`: walk from `start` toward `stop` (inclusive),
 * closest-first. At each level, for each target (in target order), yield
 * `<current>/<target>` if it exists. Never throws.
 */
function upWalk(targets: string[], start: string, stop?: string): string[] {
  const results: string[] = []
  let current = path.resolve(start)
  const resolvedStop = stop === undefined ? undefined : path.resolve(stop)
  // eslint-disable-next-line no-constant-condition -- bounded by filesystem root
  while (true) {
    for (const target of targets) {
      const candidate = path.join(current, target)
      try {
        if (fs.existsSync(candidate)) {
          results.push(candidate)
        }
      } catch {
        // unreadable candidate: skip, never throw
      }
    }
    if (resolvedStop !== undefined && current === resolvedStop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return results
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

/**
 * Build the list of OpenCode config directories exactly like upstream's
 * `ConfigPaths.directories`: the global config dir, then the project-level
 * `.opencode` up-walk (closest-first), then `<home>/.opencode` if present,
 * then the `OPENCODE_CONFIG_DIR` override if provided, deduplicated
 * preserving first-seen order (matches upstream's `unique()` semantics).
 */
function buildOpencodeConfigDirs(
  startDir: string,
  homeDir: string,
  gitRoot: string | null,
  globalConfigDir: string,
  opencodeConfigDirOverride?: string,
): string[] {
  const dirs: string[] = [globalConfigDir]

  // No git worktree root: bound the walk to startDir itself rather than
  // climbing to the filesystem root.
  dirs.push(...upWalk(['.opencode'], startDir, gitRoot ?? startDir))
  dirs.push(...upWalk(['.opencode'], homeDir, homeDir))

  if (opencodeConfigDirOverride !== undefined) {
    dirs.push(opencodeConfigDirOverride)
  }

  return uniqueStrings(dirs)
}

/**
 * Recursively find all `SKILL.md` files matching `<rootDir>/<subdirGlob>/**\/SKILL.md`
 * for each entry in `subdirNames` (e.g. `['skill', 'skills']` or `['skills']`).
 * Uses the node-native `walkDir` walker for the recursive `**` matching
 * (skill trees are shallow; `maxDepth: 10` is a generous cap since walkDir's
 * default of 3 could miss deeply nested skills).
 * Never throws: missing roots yield no matches; unreadable nested dirs are
 * caught and skipped (walkDir does not internally guard readdir errors).
 */
function globSkillFiles(rootDir: string, subdirNames: string[]): string[] {
  const results: string[] = []
  for (const subdirName of subdirNames) {
    const scanRoot = path.join(rootDir, subdirName)
    try {
      if (!fs.existsSync(scanRoot)) continue
      const entries = walkDir(scanRoot, {
        maxDepth: 10,
        filter: (entry) => !entry.isDirectory && entry.name === 'SKILL.md',
      })
      for (const entry of entries) {
        results.push(entry.path)
      }
    } catch {
      // unreadable dir: skip, never throw
    }
  }
  return results
}

/**
 * Turn a discovered `SKILL.md` absolute path into a `DiscoveredSkill`, or
 * `undefined` if it should be skipped (unreadable, not a file, no
 * frontmatter name, or invalid name charset/length). Never throws.
 */
function toDiscoveredSkill(
  skillPath: string,
  rootId: DiscoveryRootId,
): DiscoveredSkill | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(skillPath)
  } catch {
    return undefined // missing or unreadable: skip
  }
  if (!stat.isFile()) return undefined

  const frontmatter = extractFrontmatter(skillPath)
  const name = frontmatter.name
  if (!name || !isValidSkillName(name)) return undefined

  return {
    name,
    description: frontmatter.description,
    frontmatter,
    skillPath,
    root: rootId,
  }
}

/**
 * Discover user/project skills, replicating OpenCode v1.17.6's real
 * discovery algorithm (verified from source: `skill/index.ts`,
 * `config/paths.ts`, `util/filesystem.ts`). Builds ONE map keyed by
 * frontmatter skill `name`; entries are scanned and upserted in upstream's
 * exact sequence, and later additions overwrite earlier ones:
 *
 *   1. Global external: `<home>/.claude/skills/**\/SKILL.md`, then
 *      `<home>/.agents/skills/**\/SKILL.md`.
 *   2. Project external (multi-level up-walk): from `startDir` up to the
 *      git worktree root (inclusive), closest-first; at each level scan
 *      `.claude/skills/**\/SKILL.md` then `.agents/skills/**\/SKILL.md`.
 *      Because of last-write-wins, the worktree-root level wins over
 *      deeper subdirectories.
 *   3. OpenCode config dirs (`ConfigPaths.directories`-equivalent: global
 *      config dir, then project `.opencode` up-walk, then `<home>/.opencode`,
 *      then an optional `OPENCODE_CONFIG_DIR`-style override), each scanned
 *      for `{skill,skills}/**\/SKILL.md`. Scanned last, so these beat
 *      everything above.
 *
 * The dedup key is the frontmatter `name` (not the containing directory
 * name); entries with no name, or a name failing the charset/length regex,
 * are skipped. Never throws: unreadable dirs/files, missing roots, or
 * malformed frontmatter cause that entry to be skipped, not an abort.
 */
export function discoverSkills(
  options: DiscoverSkillsOptions,
): DiscoveredSkill[] {
  const { startDir, homeDir, configDir, opencodeConfigDirOverride } = options
  const globalConfigDir = configDir ?? path.join(homeDir, '.config/opencode')
  const gitRoot = findGitWorktreeRoot(startDir)

  const byName = new Map<string, DiscoveredSkill>()

  function upsertAll(skillPaths: string[], rootId: DiscoveryRootId): void {
    for (const skillPath of skillPaths) {
      const skill = toDiscoveredSkill(skillPath, rootId)
      if (skill) byName.set(skill.name, skill)
    }
  }

  // 1. Global external: .claude then .agents.
  upsertAll(globSkillFiles(homeDir, ['.claude/skills']), 'global-claude')
  upsertAll(globSkillFiles(homeDir, ['.agents/skills']), 'global-agents')

  // 2. Project external: multi-level up-walk from startDir to worktree root,
  // closest-first, .claude then .agents at each level.
  const externalLevels = upWalk(
    ['.claude', '.agents'],
    startDir,
    gitRoot ?? startDir,
  )
  for (const levelDir of externalLevels) {
    const isClaudeDir = path.basename(levelDir) === '.claude'
    const parentDir = path.dirname(levelDir)
    const subdirGlob = isClaudeDir ? '.claude/skills' : '.agents/skills'
    const rootId: DiscoveryRootId = isClaudeDir
      ? 'project-claude'
      : 'project-agents'
    upsertAll(globSkillFiles(parentDir, [subdirGlob]), rootId)
  }

  // 3. OpenCode config dirs: last, so these beat everything above.
  const configDirs = buildOpencodeConfigDirs(
    startDir,
    homeDir,
    gitRoot,
    globalConfigDir,
    opencodeConfigDirOverride,
  )
  for (const dir of configDirs) {
    const rootId: DiscoveryRootId =
      dir === globalConfigDir ? 'global-opencode-config' : 'project-opencode'
    upsertAll(globSkillFiles(dir, ['skill', 'skills']), rootId)
  }

  return Array.from(byName.values())
}
