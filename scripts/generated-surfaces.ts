#!/usr/bin/env bun
/**
 * Runner for the generated-surface list in `scripts/lib/generated-surfaces.ts`.
 *
 *   bun run surfaces:regen              regenerate every surface, in list order
 *   bun run surfaces:drift              check every surface, report each by name
 *   bun run surfaces:affected           list surfaces the working tree makes stale
 *   bun run surfaces:affected --run     regenerate that set, then check it
 *
 * Every surface command runs as `bun run <script>` from the repo root with its
 * output buffered, so one child's output never interleaves with another's.
 * The command functions take the spawn function as an argument; tests pass a
 * fake and never start a real generator.
 *
 * Exit codes: 0 success, 1 a surface or the environment failed, 2 usage error.
 *
 * `--allow-shrink` (the generators' shrink-guard override) is deliberately not
 * accepted here: bypassing the guard stays a hand-run decision.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import {
  ChangeSetError,
  checkPreflight,
  formatAffectedSurface,
  formatDriftSummary,
  formatNothingToRegenerate,
  formatPreflightFailure,
  formatRegenFailure,
  formatSurfaceResult,
  GENERATED_SURFACES,
  type GeneratedSurface,
  listRepoFiles,
  resolveChangeSet,
  type SurfaceResult,
  selectAffected,
} from './lib/generated-surfaces.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')

// ── Context ─────────────────────────────────────────────────────────────────

export interface SpawnResult {
  /** `null` when the child was killed by a signal or never started. */
  readonly exitCode: number | null
  /** The child's stdout and stderr in arrival order, unaltered. */
  readonly output: string
}

/** Runs `argv` in `cwd` and resolves once the child has exited. Never rejects. */
export type SpawnCommand = (
  argv: readonly string[],
  cwd: string,
) => Promise<SpawnResult>

export interface RunnerContext {
  readonly rootDir: string
  readonly surfaces: readonly GeneratedSurface[]
  readonly spawn: SpawnCommand
  /** Where report lines go. Defaults to the process streams. */
  readonly report?: (text: string, stream: 'out' | 'err') => void
}

function emit(context: RunnerContext, text: string, stream: 'out' | 'err') {
  if (context.report !== undefined) {
    context.report(text, stream)
    return
  }
  const target = stream === 'out' ? process.stdout : process.stderr
  target.write(`${text}\n`)
}

/** The real spawn: buffers both streams in the order the chunks arrive. */
export const spawnCommand: SpawnCommand = (argv, cwd) =>
  new Promise((resolve) => {
    const [command, ...args] = argv
    if (command === undefined) {
      resolve({ exitCode: null, output: 'no command to run' })
      return
    }
    const chunks: string[] = []
    let settled = false
    const settle = (result: SpawnResult) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    const child = nodeSpawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        chunks.push(chunk)
      })
    }
    child.on('error', (error) => {
      chunks.push(`failed to start ${command}: ${error.message}\n`)
      settle({ exitCode: null, output: chunks.join('') })
    })
    child.on('close', (code) => {
      settle({ exitCode: code, output: chunks.join('') })
    })
  })

function scriptArgv(script: string): readonly string[] {
  return ['bun', 'run', script]
}

// ── Shared steps ────────────────────────────────────────────────────────────

/** Reports a missing install and returns false, or returns true. */
function preflightPasses(context: RunnerContext): boolean {
  const preflight = checkPreflight(context.rootDir)
  if (preflight.ok) {
    return true
  }
  emit(context, formatPreflightFailure(preflight.missing), 'err')
  return false
}

/**
 * Regenerates `selected` in order and stops at the first failure. `true` when
 * every surface regenerated.
 */
async function regenerateAll(
  context: RunnerContext,
  selected: readonly GeneratedSurface[],
): Promise<boolean> {
  for (const [index, surface] of selected.entries()) {
    const result = await context.spawn(
      scriptArgv(surface.regenScript),
      context.rootDir,
    )
    if (result.exitCode !== 0) {
      emit(
        context,
        formatRegenFailure({
          failed: surface,
          output: result.output,
          completed: selected.slice(0, index),
          notRun: selected.slice(index + 1),
        }),
        'err',
      )
      return false
    }
    emit(context, `[REGEN] ${surface.name}`, 'out')
  }
  return true
}

/**
 * Checks every surface in `selected`, never stopping early, and prints one
 * line per surface plus the summary. `true` when every check passed.
 */
async function checkAll(
  context: RunnerContext,
  selected: readonly GeneratedSurface[],
): Promise<boolean> {
  const results: SurfaceResult[] = []
  for (const surface of selected) {
    const spawned = await context.spawn(
      scriptArgv(surface.checkScript),
      context.rootDir,
    )
    const result: SurfaceResult = {
      surface,
      passed: spawned.exitCode === 0,
      output: spawned.output,
    }
    results.push(result)
    emit(context, formatSurfaceResult(result), 'out')
  }
  emit(context, formatDriftSummary(results), 'out')
  return results.every((result) => result.passed)
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Preflight, then regenerate every surface in list order. Returns the exit code. */
export async function runRegen(context: RunnerContext): Promise<number> {
  if (!preflightPasses(context)) {
    return 1
  }
  if (!(await regenerateAll(context, context.surfaces))) {
    return 1
  }
  emit(context, `regen: regenerated ${context.surfaces.length} surfaces`, 'out')
  return 0
}

/** Preflight, then every check in turn. Returns the exit code. */
export async function runDrift(context: RunnerContext): Promise<number> {
  if (!preflightPasses(context)) {
    return 1
  }
  return (await checkAll(context, context.surfaces)) ? 0 : 1
}

export interface AffectedOptions {
  readonly run: boolean
}

/**
 * Without `run`: build the change set and list the affected surfaces; no
 * preflight, nothing written. With `run`: preflight, regenerate that set in
 * list order, then check the same set.
 */
export async function runAffected(
  context: RunnerContext,
  options: AffectedOptions,
): Promise<number> {
  if (options.run && !preflightPasses(context)) {
    return 1
  }

  let selected: readonly GeneratedSurface[]
  let downstreamNames: ReadonlySet<string>
  try {
    const picked = selectAffected(
      context.surfaces,
      resolveChangeSet(context.rootDir),
      listRepoFiles(context.rootDir),
    )
    downstreamNames = new Set(picked.downstream.map((surface) => surface.name))
    const reached = new Set([
      ...picked.direct.map((surface) => surface.name),
      ...downstreamNames,
    ])
    selected = context.surfaces.filter((surface) => reached.has(surface.name))
  } catch (error) {
    if (error instanceof ChangeSetError) {
      emit(context, error.message, 'err')
      return 1
    }
    throw error
  }

  if (selected.length === 0) {
    emit(context, formatNothingToRegenerate(), 'out')
    return 0
  }

  if (!options.run) {
    for (const surface of selected) {
      emit(
        context,
        formatAffectedSurface(surface, downstreamNames.has(surface.name)),
        'out',
      )
    }
    emit(
      context,
      'to regenerate and check these, run: bun run surfaces:affected --run',
      'out',
    )
    return 0
  }

  if (!(await regenerateAll(context, selected))) {
    return 1
  }
  return (await checkAll(context, selected)) ? 0 : 1
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export const USAGE = [
  'usage: bun scripts/generated-surfaces.ts <command>',
  '',
  'commands:',
  '  regen              regenerate every generated surface, in order',
  '  drift              check every generated surface and report each',
  '  affected [--run]   list surfaces the working tree makes stale;',
  '                     with --run, regenerate that set and check it',
].join('\n')

export type ParsedArgs =
  | { readonly kind: 'regen' }
  | { readonly kind: 'drift' }
  | { readonly kind: 'affected'; readonly run: boolean }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage-error'; readonly message: string }

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv
  if (command === undefined) {
    return { kind: 'usage-error', message: 'missing command' }
  }
  if (command === '--help' || command === '-h') {
    return { kind: 'help' }
  }
  if (command === 'regen' || command === 'drift') {
    const [extra] = rest
    return extra === undefined
      ? { kind: command }
      : {
          kind: 'usage-error',
          message: `unknown argument for ${command}: ${extra}`,
        }
  }
  if (command === 'affected') {
    const unknown = rest.find((arg) => arg !== '--run')
    return unknown === undefined
      ? { kind: 'affected', run: rest.length > 0 }
      : {
          kind: 'usage-error',
          message: `unknown argument for affected: ${unknown}`,
        }
  }
  return { kind: 'usage-error', message: `unknown command: ${command}` }
}

/** Parse `argv` (without the runtime and script path) and run. Returns the exit code. */
export async function main(
  argv: readonly string[],
  context: RunnerContext,
): Promise<number> {
  const parsed = parseArgs(argv)
  switch (parsed.kind) {
    case 'help':
      emit(context, USAGE, 'out')
      return 0
    case 'usage-error':
      emit(context, `${parsed.message}\n\n${USAGE}`, 'err')
      return 2
    case 'regen':
      return runSafely(context, () => runRegen(context))
    case 'drift':
      return runSafely(context, () => runDrift(context))
    case 'affected':
      return runSafely(context, () => runAffected(context, { run: parsed.run }))
  }
}

/** An unexpected throw (for example, not inside a git repo) is a failure, not a crash. */
async function runSafely(
  context: RunnerContext,
  command: () => Promise<number>,
): Promise<number> {
  try {
    return await command()
  } catch (error) {
    emit(
      context,
      `generated-surfaces: ${error instanceof Error ? error.message : String(error)}`,
      'err',
    )
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    rootDir: ROOT_DIR,
    surfaces: GENERATED_SURFACES,
    spawn: spawnCommand,
  })
}
