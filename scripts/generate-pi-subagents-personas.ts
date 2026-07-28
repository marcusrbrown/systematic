#!/usr/bin/env bun
/**
 * Generate pi-subagents-compatible persona files from a curated subset of
 * Systematic's `agents/` source.
 *
 * Contract (v0.14.1 pi-subagents):
 *   - Flat .md filename is the agent identity.
 *   - Frontmatter fields are optional.
 *   - Omit tools, skills, model for maximum compatibility/inheritance.
 *   - Emit `description` only (do NOT emit `name` frontmatter).
 *   - Generated filename: `systematic-<sanitized-name>.md`
 *
 * Usage:
 *   bun scripts/generate-pi-subagents-personas.ts          # Write committed fixtures
 *   bun scripts/generate-pi-subagents-personas.ts --check  # Compare against committed fixtures; exit 0 if up-to-date
 *
 * The output directory is tests/fixtures/pi-subagents-personas/ (committed
 * source-side fixtures, not a user directory). User-dir writes are Unit 2.
 *
 * All helpers are pure exports. The executable entrypoint is guarded with
 * `if (import.meta.main)`. No user-directory writes in this module.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export type {
  CompatibilitySeverity,
  CompatibilityStatus,
  CuratedPersonaEntry,
  ManifestEntry,
} from '../src/lib/pi-subagents-personas.js'
// Pure generation logic lives in src/lib so both src/ and scripts/ can import it.
export {
  CURATED_PERSONAS,
  classifyCompatibility,
  generateAll,
  generatePersonaContent,
  generatePersonaManifest,
  sanitizeName,
} from '../src/lib/pi-subagents-personas.js'

import type { ManifestEntry } from '../src/lib/pi-subagents-personas.js'
import { generateAll } from '../src/lib/pi-subagents-personas.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

/** Committed fixture dir (source-side drift gate, analogous to registry --check). */
const FIXTURE_DIR = path.join(
  PROJECT_ROOT,
  'tests',
  'fixtures',
  'pi-subagents-personas',
)

// ── Script-only types ─────────────────────────────────────────────────────────

/** The full manifest written alongside the generated persona files (fixtures). */
export interface PersonaManifest {
  generatedAt: string
  entries: ManifestEntry[]
}

interface DriftCheckResult {
  ok: boolean
  staleFiles: string[]
  messages: string[]
}

// ── Drift check (unit-level) ──────────────────────────────────────────────────

/**
 * Compare generated content (from `entries`) against files on disk in `outputDir`.
 *
 * Drift is detected when:
 *   - A file expected by an entry is missing from outputDir
 *   - A file in outputDir has different content than the entry's hash
 */
export function checkDrift(
  outputDir: string,
  manifest: PersonaManifest,
): DriftCheckResult {
  const staleFiles: string[] = []
  const messages: string[] = []

  for (const entry of manifest.entries) {
    if (entry.status === 'excluded-critical') continue
    if (!entry.content) continue

    const filePath = path.join(outputDir, entry.filename)

    if (!fs.existsSync(filePath)) {
      staleFiles.push(entry.filename)
      messages.push(`Missing file: ${entry.filename} (expected from manifest)`)
      continue
    }

    const onDisk = fs.readFileSync(filePath, 'utf-8')
    const onDiskHash = crypto.createHash('sha256').update(onDisk).digest('hex')

    if (onDiskHash !== entry.hash) {
      staleFiles.push(entry.filename)
      messages.push(
        `Stale file: ${entry.filename} (disk hash ${onDiskHash.slice(0, 8)}… ≠ expected hash ${entry.hash.slice(0, 8)}…)`,
      )
    }
  }

  return { ok: staleFiles.length === 0, staleFiles, messages }
}

// ── Source-side fixture check (CLI --check) ───────────────────────────────────

/**
 * Check committed fixtures in FIXTURE_DIR against freshly generated output.
 */
export function checkFixtureDrift(
  repoRoot: string,
  fixtureDir: string,
): { ok: boolean; failures: string[] } {
  const failures: string[] = []

  let entries: ManifestEntry[]
  try {
    entries = generateAll(repoRoot)
  } catch (err) {
    return { ok: false, failures: [(err as Error).message] }
  }

  const expectedFilenames = new Set(
    entries
      .filter((e) => e.status !== 'excluded-critical' && e.content)
      .map((e) => e.filename),
  )

  if (!fs.existsSync(fixtureDir)) {
    return {
      ok: false,
      failures: [
        `Fixture directory does not exist: ${path.relative(repoRoot, fixtureDir)}\n` +
          'Run `bun scripts/generate-pi-subagents-personas.ts` to create it.',
      ],
    }
  }

  for (const entry of entries) {
    if (entry.status === 'excluded-critical' || !entry.content) continue

    const fixturePath = path.join(fixtureDir, entry.filename)
    const relFixture = path.relative(repoRoot, fixturePath)

    if (!fs.existsSync(fixturePath)) {
      failures.push(
        `Missing fixture: ${relFixture} (run generator without --check to create it)`,
      )
      continue
    }

    const onDisk = fs.readFileSync(fixturePath, 'utf-8')
    const onDiskHash = crypto.createHash('sha256').update(onDisk).digest('hex')
    if (onDiskHash !== entry.hash) {
      failures.push(
        `Stale fixture: ${relFixture} (run generator without --check to update it)`,
      )
    }
  }

  const onDiskMd = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.md'))
  for (const f of onDiskMd) {
    if (!expectedFilenames.has(f)) {
      failures.push(
        `Unexpected fixture: ${path.join(path.relative(repoRoot, fixtureDir), f)} (no longer in curated list; run generator to clean up)`,
      )
    }
  }

  return { ok: failures.length === 0, failures }
}

// ── Main helpers ──────────────────────────────────────────────────────────────

function writeFixtures(entries: ManifestEntry[]): {
  written: number
  upToDate: number
} {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })

  let written = 0
  let upToDate = 0

  for (const entry of entries) {
    if (entry.status === 'excluded-critical' || !entry.content) continue

    const fixturePath = path.join(FIXTURE_DIR, entry.filename)
    let needsWrite = true
    try {
      const existing = fs.readFileSync(fixturePath, 'utf-8')
      const existingHash = crypto
        .createHash('sha256')
        .update(existing)
        .digest('hex')
      if (existingHash === entry.hash) needsWrite = false
    } catch {
      // File doesn't exist — write it
    }

    if (needsWrite) {
      fs.writeFileSync(fixturePath, entry.content, 'utf-8')
      written++
    } else {
      upToDate++
    }
  }

  const manifest: PersonaManifest = {
    generatedAt: new Date().toISOString(),
    entries: entries.map((e) => ({
      filename: e.filename,
      status: e.status,
      sourceRelPath: e.sourceRelPath,
      hash: e.hash,
      reason: e.reason,
    })),
  }
  const manifestPath = path.join(
    FIXTURE_DIR,
    'systematic-personas-manifest.json',
  )
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  )

  return { written, upToDate }
}

function printSummary(entries: ManifestEntry[]): void {
  for (const entry of entries) {
    const tag =
      entry.status === 'exported'
        ? '✓'
        : entry.status === 'exported-with-warning'
          ? '⚠'
          : '✗'
    console.log(
      `  ${tag} ${entry.filename} [${entry.status}]` +
        (entry.reason ? ` — ${entry.reason}` : ''),
    )
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2)
  const checkMode = args.includes('--check')

  if (checkMode) {
    const { ok, failures } = checkFixtureDrift(PROJECT_ROOT, FIXTURE_DIR)
    if (ok) {
      console.log(`${path.relative(PROJECT_ROOT, FIXTURE_DIR)} is up to date.`)
      process.exit(0)
    }
    for (const msg of failures) {
      console.error(`Error: ${msg}`)
    }
    process.exit(1)
  }

  let entries: ManifestEntry[]
  try {
    entries = generateAll(PROJECT_ROOT)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  const { written, upToDate } = writeFixtures(entries)
  const relDir = path.relative(PROJECT_ROOT, FIXTURE_DIR)

  if (written > 0) {
    console.log(
      `Generated ${written} persona file(s) in ${relDir}/ (${upToDate} already up to date).`,
    )
  } else {
    console.log(
      `All ${upToDate} persona file(s) in ${relDir}/ are already up to date.`,
    )
  }

  console.log('\nPersona summary:')
  printSummary(entries)
}

if (import.meta.main) {
  main()
}
