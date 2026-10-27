/**
 * The ordered list of generated surfaces, plus the pure logic that reads it:
 * glob matching, downstream closure, git change-set resolution, the
 * `node_modules` preflight and the report-line formatters.
 *
 * Every committed generated file belongs to exactly one surface. A surface
 * names its regeneration and check scripts (both `package.json` script names),
 * the files it writes (`outputs`) and the files whose change can make it stale
 * (`triggers`). The runner in `scripts/generated-surfaces.ts` reads this list
 * for `surfaces:regen`, `surfaces:drift` and `surfaces:affected`.
 *
 * Paths are declared as literals and the generators are not imported: loading
 * them would pull Zod and the schemas into every command. Tests compare the
 * literals with the generators' exported path constants and with the real file
 * tree, so a rename or a dead glob fails loudly.
 *
 * Nothing in this file writes. All functions take `rootDir` so tests can point
 * them at a temp repo.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// ── The list ────────────────────────────────────────────────────────────────

export interface GeneratedSurface {
  readonly name: string
  /** `package.json` script that rewrites the outputs. */
  readonly regenScript: string
  /** `package.json` script that exits non-zero when the outputs are stale. */
  readonly checkScript: string
  /** Files the surface writes: literal paths, plus two globs. */
  readonly outputs: readonly string[]
  /** Globs of files whose change can make the surface stale. */
  readonly triggers: readonly string[]
}

/**
 * Regeneration order. Surface B is downstream of surface A when a file A
 * writes matches a trigger of B, so A must come first; a test asserts every
 * derived edge points forward in this order.
 *
 * A surface whose outputs are also its triggers (agent-browser's
 * `ATTRIBUTIONS.md`, the schema's `bundled-names.ts`, the registry's own
 * file) re-matches itself after a commit. That over-reports harmlessly.
 *
 * Triggers were derived from each generator's transitive imports. The
 * config-reference generator imports `scripts/generate-config-schema.ts` and
 * `src/lib/config-schema.ts`, so it carries the schema surface's source
 * modules. Over-reporting is the safe direction; CI runs the full drift.
 */
export const GENERATED_SURFACES: readonly GeneratedSurface[] = [
  {
    name: 'agent-browser',
    regenScript: 'agent-browser:build',
    checkScript: 'agent-browser:drift',
    outputs: ['skills/agent-browser/SKILL.md', 'ATTRIBUTIONS.md'],
    triggers: [
      'scripts/generate-agent-browser-skill.ts',
      'package.json',
      'bun.lock',
      'ATTRIBUTIONS.md',
    ],
  },
  {
    name: 'schema',
    regenScript: 'schema:generate',
    checkScript: 'schema:drift',
    outputs: [
      'docs/public/schemas/v*/systematic-config.schema.json',
      'src/lib/bundled-names.ts',
    ],
    triggers: [
      'scripts/generate-config-schema.ts',
      'scripts/lib/zod-internals.ts',
      'src/lib/agent-colors.ts',
      'src/lib/agents.ts',
      'src/lib/bundled-names.ts',
      'src/lib/config-schema.ts',
      'src/lib/frontmatter.ts',
      'src/lib/removed-names.ts',
      'src/lib/skills.ts',
      'src/lib/validation.ts',
      'src/lib/walk-dir.ts',
      'agents/**/*.md',
      'skills/*/SKILL.md',
      'biome.json',
      'package.json',
      'bun.lock',
    ],
  },
  {
    name: 'config-reference',
    regenScript: 'config-reference:generate',
    checkScript: 'config-reference:drift',
    outputs: ['docs/src/content/docs/reference/configuration.mdx'],
    triggers: [
      'docs/scripts/generate-config-reference.ts',
      'scripts/generate-config-schema.ts',
      'scripts/lib/zod-internals.ts',
      'src/lib/agent-colors.ts',
      'src/lib/agents.ts',
      'src/lib/bundled-names.ts',
      'src/lib/config-schema.ts',
      'src/lib/frontmatter.ts',
      'src/lib/removed-names.ts',
      'src/lib/skills.ts',
      'src/lib/validation.ts',
      'src/lib/walk-dir.ts',
      'package.json',
      'bun.lock',
    ],
  },
  {
    name: 'review-schemas',
    regenScript: 'review-schema:generate',
    checkScript: 'review-schema:drift',
    outputs: [
      'skills/ce-review/references/review-summary-schema.json',
      'skills/ce-review/references/findings-schema.json',
      'skills/ce-review/references/review-pipeline-schema.json',
    ],
    triggers: [
      'scripts/generate-review-artifact-schema.ts',
      'src/lib/review-artifact-schema.ts',
      'src/lib/review-pipeline-contract.ts',
      'biome.json',
      'package.json',
      'bun.lock',
    ],
  },
  {
    name: 'validator',
    regenScript: 'ce-review-validator:build',
    checkScript: 'ce-review-validator:drift',
    outputs: ['skills/ce-review/scripts/validate-review.mjs'],
    triggers: [
      'scripts/generate-ce-review-validator.ts',
      'src/ce-review-validator.ts',
      'src/claude-code-validator.ts',
      'src/lib/review-artifact-path.ts',
      'src/lib/review-artifact-schema.ts',
      'src/lib/review-pipeline-contract.ts',
      'src/lib/review-pipeline.ts',
      'src/lib/review-return-validator.ts',
      'biome.json',
      'package.json',
      'bun.lock',
    ],
  },
  {
    name: 'registry',
    regenScript: 'registry:generate',
    checkScript: 'registry:drift',
    outputs: ['registry/registry.jsonc'],
    triggers: [
      'scripts/generate-registry.ts',
      'src/lib/agents.ts',
      'src/lib/frontmatter.ts',
      'src/lib/skills.ts',
      'src/lib/validation.ts',
      'src/lib/walk-dir.ts',
      'agents/**',
      'skills/**',
      'registry/registry.jsonc',
      'biome.json',
    ],
  },
  {
    name: 'pi-personas',
    regenScript: 'pi-personas:generate',
    checkScript: 'pi-personas:drift',
    outputs: ['tests/fixtures/pi-subagents-personas/**'],
    triggers: [
      'scripts/generate-pi-subagents-personas.ts',
      'src/lib/pi-subagents-personas.ts',
      'src/lib/frontmatter.ts',
      'agents/**/*.md',
    ],
  },
]

// ── Globs ───────────────────────────────────────────────────────────────────

const globCache = new Map<string, Bun.Glob>()

/** True when `filePath` (repo-relative, `/`-separated) matches `pattern`. */
export function matchesGlob(pattern: string, filePath: string): boolean {
  let glob = globCache.get(pattern)
  if (glob === undefined) {
    glob = new Bun.Glob(pattern)
    globCache.set(pattern, glob)
  }
  return glob.match(filePath)
}

/** The text before the first `*`; the whole path for a literal. */
export function literalPrefix(pattern: string): string {
  const star = pattern.indexOf('*')
  return star === -1 ? pattern : pattern.slice(0, star)
}

/** The files in `repoFiles` that the surface's output entries match. */
export function expandOutputs(
  surface: GeneratedSurface,
  repoFiles: readonly string[],
): string[] {
  return repoFiles.filter((file) =>
    surface.outputs.some((output) => matchesGlob(output, file)),
  )
}

export interface DeadPath {
  readonly surface: string
  readonly kind: 'trigger' | 'output'
  readonly pattern: string
}

/**
 * Trigger globs that match no file and output entries that expand to nothing.
 * Checked per entry, never per surface, so one live glob cannot hide a dead
 * one.
 */
export function findDeadPaths(
  surfaces: readonly GeneratedSurface[],
  repoFiles: readonly string[],
): DeadPath[] {
  const dead: DeadPath[] = []
  for (const surface of surfaces) {
    const entries = [
      ...surface.triggers.map((pattern) => ({
        kind: 'trigger' as const,
        pattern,
      })),
      ...surface.outputs.map((pattern) => ({
        kind: 'output' as const,
        pattern,
      })),
    ]
    for (const { kind, pattern } of entries) {
      if (!repoFiles.some((file) => matchesGlob(pattern, file))) {
        dead.push({ surface: surface.name, kind, pattern })
      }
    }
  }
  return dead
}

// ── Closure ─────────────────────────────────────────────────────────────────

export interface ClosureEdge {
  readonly from: string
  readonly to: string
}

/**
 * `from` is upstream of `to` when an expanded output path of `from` matches a
 * trigger glob of `to`: a real path against a pattern, never two patterns
 * against each other. Self-edges are dropped.
 */
export function deriveClosureEdges(
  surfaces: readonly GeneratedSurface[],
  repoFiles: readonly string[],
): ClosureEdge[] {
  const edges: ClosureEdge[] = []
  for (const upstream of surfaces) {
    const written = expandOutputs(upstream, repoFiles)
    for (const downstream of surfaces) {
      if (downstream.name === upstream.name) {
        continue
      }
      const linked = written.some((file) =>
        downstream.triggers.some((trigger) => matchesGlob(trigger, file)),
      )
      if (linked) {
        edges.push({ from: upstream.name, to: downstream.name })
      }
    }
  }
  return edges
}

/** Edges that point at an earlier (or the same) position in the list. */
export function findBackwardEdges(
  surfaces: readonly GeneratedSurface[],
  edges: readonly ClosureEdge[],
): ClosureEdge[] {
  const order = surfaces.map((surface) => surface.name)
  return edges.filter(
    (edge) => order.indexOf(edge.from) >= order.indexOf(edge.to),
  )
}

export interface AffectedSurfaces {
  /** Surfaces with a trigger or output matching a changed path, in list order. */
  readonly direct: readonly GeneratedSurface[]
  /** Surfaces reached only through the closure, in list order. */
  readonly downstream: readonly GeneratedSurface[]
}

export function selectAffected(
  surfaces: readonly GeneratedSurface[],
  changedPaths: readonly string[],
  repoFiles: readonly string[],
): AffectedSurfaces {
  // A changed output (a hand edit, or a deleted generated file) makes its own
  // surface stale just as a changed trigger does.
  const direct = surfaces.filter((surface) =>
    [...surface.triggers, ...surface.outputs].some((pattern) =>
      changedPaths.some((file) => matchesGlob(pattern, file)),
    ),
  )
  const edges = deriveClosureEdges(surfaces, repoFiles)
  const reached = new Set(direct.map((surface) => surface.name))
  const queue = [...reached]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const edge of edges) {
      if (edge.from === name && !reached.has(edge.to)) {
        reached.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  const directNames = new Set(direct.map((surface) => surface.name))
  return {
    direct,
    downstream: surfaces.filter(
      (surface) => reached.has(surface.name) && !directNames.has(surface.name),
    ),
  }
}

// ── package.json scripts ────────────────────────────────────────────────────

/**
 * The repo-relative file a `bun <file>` package script runs, or `undefined`
 * when the script is missing or is not a plain `bun <file>` command.
 */
export function resolveScriptFile(
  rootDir: string,
  scriptName: string,
): string | undefined {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
  )
  if (typeof manifest !== 'object' || manifest === null) {
    return undefined
  }
  const scripts: unknown = Reflect.get(manifest, 'scripts')
  if (typeof scripts !== 'object' || scripts === null) {
    return undefined
  }
  const command: unknown = Reflect.get(scripts, scriptName)
  if (typeof command !== 'string') {
    return undefined
  }
  const match = /^bun\s+(\S+\.(?:ts|mts|js|mjs))(?:\s|$)/.exec(command)
  return match?.[1]?.replace(/^\.\//, '')
}

// ── Git ─────────────────────────────────────────────────────────────────────

const BASE_REF = 'origin/main'

/** Thrown when the change set cannot be built; never returned as an empty set. */
export class ChangeSetError extends Error {
  readonly ref: string
  readonly kind: 'missing-ref' | 'missing-merge-base'
  readonly shallow: boolean

  constructor(
    kind: 'missing-ref' | 'missing-merge-base',
    ref: string,
    shallow: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'ChangeSetError'
    this.kind = kind
    this.ref = ref
    this.shallow = shallow
  }
}

const SHALLOW_HINT =
  'This clone is shallow. Run `git fetch --unshallow` (or deepen it with `git fetch --deepen=<n>`) and retry.'

function gitEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('GIT_') && entry[1] !== undefined,
    ),
  )
}

interface GitResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when git could not run to completion (not installed, output over `maxBuffer`). */
  readonly error?: string
}

function runGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  }
}

/** The failure text for a git call: the spawn error when there is one, else stderr. */
function failureDetail(result: GitResult): string {
  return result.error ?? result.stderr.trim()
}

/** Git never ran to completion: its exit status says nothing about the repo. */
function launchError(args: readonly string[], result: GitResult): Error {
  return new Error(
    `git ${args.join(' ')} could not run: ${failureDetail(result)}`,
  )
}

/** The repo root. `ls-files --others` is cwd-relative, so every call uses it. */
function repoTopLevel(rootDir: string): string {
  const result = runGit(rootDir, ['rev-parse', '--show-toplevel'])
  if (result.error !== undefined) {
    throw launchError(['rev-parse', '--show-toplevel'], result)
  }
  const top = result.stdout.trim()
  if (result.status !== 0 || top === '') {
    throw new Error(
      `${rootDir} is not inside a git repository: ${result.stderr.trim()}`,
    )
  }
  return top
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '')
}

function gitList(cwd: string, args: readonly string[]): string[] {
  const result = runGit(cwd, args)
  if (result.status !== 0) {
    throw result.error === undefined
      ? new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
      : launchError(args, result)
  }
  return splitNul(result.stdout)
}

/** Tracked plus untracked (not ignored) files, repo-root-relative and sorted. */
export function listRepoFiles(rootDir: string): string[] {
  const top = repoTopLevel(rootDir)
  const files = gitList(top, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
  return [...new Set(files)].sort()
}

function isShallow(cwd: string): boolean {
  return (
    runGit(cwd, ['rev-parse', '--is-shallow-repository']).stdout.trim() ===
    'true'
  )
}

/**
 * Paths changed since the merge-base with `origin/main`: staged, unstaged and
 * committed changes from a `--no-renames` diff (so a rename lists both paths
 * and a deletion is kept), plus untracked files not excluded by ignore rules.
 * Paths are repo-root-relative and sorted. An empty array means no change.
 *
 * Throws `ChangeSetError` when `origin/main` or the merge-base cannot be
 * resolved. It never fetches.
 */
export function resolveChangeSet(rootDir: string): string[] {
  const top = repoTopLevel(rootDir)

  const baseArgs = ['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`]
  const base = runGit(top, baseArgs)
  if (base.error !== undefined) {
    throw launchError(baseArgs, base)
  }
  if (base.status !== 0) {
    const shallow = isShallow(top)
    throw new ChangeSetError(
      'missing-ref',
      BASE_REF,
      shallow,
      [
        `Cannot resolve ${BASE_REF}. Fetch it (\`git fetch origin main\`) and retry.`,
        ...(shallow ? [SHALLOW_HINT] : []),
      ].join(' '),
    )
  }

  const mergeBaseArgs = ['merge-base', BASE_REF, 'HEAD']
  const mergeBase = runGit(top, mergeBaseArgs)
  if (mergeBase.error !== undefined) {
    throw launchError(mergeBaseArgs, mergeBase)
  }
  const mergeBaseSha = mergeBase.stdout.trim()
  if (mergeBase.status !== 0 || mergeBaseSha === '') {
    const shallow = isShallow(top)
    throw new ChangeSetError(
      'missing-merge-base',
      BASE_REF,
      shallow,
      [
        `Cannot find a merge-base between ${BASE_REF} and HEAD.`,
        ...(shallow ? [SHALLOW_HINT] : []),
      ].join(' '),
    )
  }

  const tracked = gitList(top, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    mergeBaseSha,
  ])
  const untracked = gitList(top, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
  return [...new Set([...tracked, ...untracked])].sort()
}

// ── Preflight ───────────────────────────────────────────────────────────────

const PREFLIGHT_REQUIREMENTS = [
  'node_modules/.bin/biome',
  'node_modules/zod',
] as const

export interface PreflightResult {
  readonly ok: boolean
  readonly missing: readonly string[]
}

/** The generators read `node_modules` and format through its Biome. */
export function checkPreflight(rootDir: string): PreflightResult {
  const missing = PREFLIGHT_REQUIREMENTS.filter(
    (requirement) => !fs.existsSync(path.join(rootDir, requirement)),
  )
  return { ok: missing.length === 0, missing }
}

// ── Report lines ────────────────────────────────────────────────────────────

const INDENT = '  '

function indentOutput(output: string): string[] {
  const trimmed = output.replace(/\s+$/, '')
  if (trimmed === '') {
    return []
  }
  return trimmed
    .split('\n')
    .map((line) => (line === '' ? '' : `${INDENT}${INDENT}${line}`))
}

function fixLine(surface: GeneratedSurface): string {
  return `${INDENT}fix: bun run ${surface.regenScript}`
}

export interface SurfaceResult {
  readonly surface: GeneratedSurface
  readonly passed: boolean
  readonly output: string
}

/** `[PASS] name`, or `[FAIL] name` + the child's output + the fix command. */
export function formatSurfaceResult(result: SurfaceResult): string {
  if (result.passed) {
    return `[PASS] ${result.surface.name}`
  }
  return [
    `[FAIL] ${result.surface.name}`,
    ...indentOutput(result.output),
    fixLine(result.surface),
  ].join('\n')
}

/** `drift: N of M failed: a, b`, or an all-passed line. */
export function formatDriftSummary(
  results: readonly Pick<SurfaceResult, 'surface' | 'passed'>[],
): string {
  const failed = results.filter((result) => !result.passed)
  if (failed.length === 0) {
    return `drift: all ${results.length} surfaces passed`
  }
  return `drift: ${failed.length} of ${results.length} failed: ${failed
    .map((result) => result.surface.name)
    .join(', ')}`
}

export function formatAffectedSurface(
  surface: GeneratedSurface,
  downstreamOnly: boolean,
): string {
  return [
    `[AFFECTED] ${surface.name}${downstreamOnly ? ' (downstream)' : ''}`,
    fixLine(surface),
  ].join('\n')
}

export function formatNothingToRegenerate(): string {
  return 'nothing to regenerate: no changed file matches a generated surface'
}

export interface RegenFailure {
  readonly failed: GeneratedSurface
  readonly output: string
  /** Surfaces regenerated before the failure. */
  readonly completed: readonly GeneratedSurface[]
  /** Surfaces never started because of the failure. */
  readonly notRun: readonly GeneratedSurface[]
}

export function formatRegenFailure(failure: RegenFailure): string {
  const lines = [
    `regen failed: ${failure.failed.name}`,
    ...indentOutput(failure.output),
  ]
  if (failure.completed.length > 0) {
    lines.push(
      `earlier surfaces were already rewritten (${failure.completed
        .map((surface) => surface.name)
        .join(', ')}), so the tree is partly regenerated`,
    )
  } else {
    lines.push('no surface was rewritten before the failure')
  }
  if (failure.notRun.length > 0) {
    lines.push('not run:')
    for (const surface of failure.notRun) {
      lines.push(`${INDENT}${surface.name}`)
    }
  }
  return lines.join('\n')
}

export function formatPreflightFailure(missing: readonly string[]): string {
  return `missing ${missing.join(', ')}: run bun install`
}
