#!/usr/bin/env bun
/**
 * Generate the packaged pi-subagents personas at build time.
 *
 * pi-subagents loads agents from `pi.subagents.agents` directories declared in
 * an installed Pi package's `package.json`. This script writes the default
 * (config-free) render of the curated personas to `dist/pi-subagents/agents/`,
 * the directory that manifest key points at. It is the last step of `build`,
 * because the publish job ships the built `dist/` and never runs
 * `prepublishOnly`.
 *
 * The files are the same render as `generateAll`, so they are byte-identical to
 * the committed fixtures and to an export with no config overlays. No manifest
 * and no timestamp are written, so the output is deterministic.
 *
 * Usage:
 *   bun scripts/build-pi-package-agents.ts   # write dist/pi-subagents/agents
 *
 * The command takes no arguments and always writes `dist/pi-subagents/agents`.
 * The exported functions take an `outDir` so tests can write elsewhere.
 *
 * The executable entrypoint is guarded with `if (import.meta.main)`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ManifestEntry } from '../src/lib/pi-subagents-personas.js'
import {
  generateAll,
  isWrittenEntry,
} from '../src/lib/pi-subagents-personas.js'

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

/** Where `package.json`'s `pi.subagents.agents` points. */
export const PI_PACKAGE_AGENTS_DIR = path.join(
  PROJECT_ROOT,
  'dist',
  'pi-subagents',
  'agents',
)

export interface BuildPiPackageAgentsOptions {
  repoRoot: string
  outDir: string
  /** Test seam: replaces `generateAll`. */
  generate?: (repoRoot: string) => ManifestEntry[]
}

export interface RunBuildPiPackageAgentsOptions
  extends BuildPiPackageAgentsOptions {
  /** Receives the failure message. Defaults to stderr. */
  onError?: (message: string) => void
}

/**
 * Write the packaged personas to `outDir`, replacing whatever was there.
 *
 * The files are fully staged in a temporary sibling before the target is
 * touched, so a failure while staging leaves the previous directory unchanged.
 * The swap itself is not atomic: the target is removed and then the staging
 * directory is renamed into place. A failure between those two steps leaves no
 * directory, which fails the build instead of shipping a partial one. Returns
 * the file names written. Throws on any failure.
 */
export function buildPiPackageAgents(
  options: BuildPiPackageAgentsOptions,
): string[] {
  const { repoRoot, outDir } = options
  const generate = options.generate ?? generateAll
  const entries = generate(repoRoot).filter(isWrittenEntry)

  for (const entry of entries) {
    if (entry.filename.includes(':')) {
      throw new Error(
        `Packaged persona file name "${entry.filename}" contains ":", which pi-subagents cannot load`,
      )
    }
  }

  const staging = `${outDir}.tmp-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    for (const entry of entries) {
      fs.writeFileSync(path.join(staging, entry.filename), entry.content)
    }
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.renameSync(staging, outDir)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return entries.map((entry) => entry.filename)
}

/** Run the build and return the process exit code. */
export function runBuildPiPackageAgents(
  options: RunBuildPiPackageAgentsOptions,
): number {
  const onError =
    options.onError ?? ((message: string) => console.error(message))
  try {
    const written = buildPiPackageAgents(options)
    console.log(
      `Wrote ${written.length} packaged pi-subagents personas to ${options.outDir}`,
    )
    return 0
  } catch (error) {
    onError(
      `build-pi-package-agents failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = runBuildPiPackageAgents({
    repoRoot: PROJECT_ROOT,
    outDir: PI_PACKAGE_AGENTS_DIR,
  })
}
