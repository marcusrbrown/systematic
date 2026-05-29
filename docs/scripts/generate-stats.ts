#!/usr/bin/env bun
/**
 * Emit a counts artifact for the docs homepage StatsBanner.
 *
 * Reads from the repo filesystem at build time and writes
 * docs/src/data/stats.json. Never hardcodes counts.
 *
 * Usage:
 *   bun docs/scripts/generate-stats.ts
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ParseError, parse as parseJsonc } from 'jsonc-parser'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const OUTPUT_PATH = path.join(__dirname, '../src/data/stats.json')

export interface Stats {
  skills: number
  agents: number
  components: number
  version: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Count skill subdirectories that contain a SKILL.md file. */
function countSkills(rootDir: string): number {
  const skillsDir = path.join(rootDir, 'skills')
  if (!fs.existsSync(skillsDir)) return 0

  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')),
    ).length
}

/** Count .md files recursively under the agents/ directory. */
function countAgents(rootDir: string): number {
  const agentsDir = path.join(rootDir, 'agents')
  if (!fs.existsSync(agentsDir)) return 0

  let count = 0
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name))
      } else if (entry.name.endsWith('.md')) {
        count++
      }
    }
  }
  walk(agentsDir)
  return count
}

/**
 * Count entries in registry/registry.jsonc.
 *
 * Throws if the file is missing, malformed, or has no components array — a
 * zero count on the homepage is worse than a build failure.
 */
function countComponents(rootDir: string): number {
  const registryPath = path.join(rootDir, 'registry', 'registry.jsonc')

  if (!fs.existsSync(registryPath)) {
    throw new Error(
      `registry/registry.jsonc not found at ${registryPath}. ` +
        'Run `bun scripts/generate-registry.ts` first.',
    )
  }

  const raw = fs.readFileSync(registryPath, 'utf8')
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(raw, errors)

  if (errors.length > 0) {
    throw new Error(
      `registry/registry.jsonc contains parse errors (${errors.length} error(s)). ` +
        'Fix the registry file before regenerating stats.',
    )
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.components)) {
    throw new Error(
      'registry/registry.jsonc is missing the `components` array. ' +
        'A zero component count would silently misrepresent the project.',
    )
  }

  return parsed.components.length
}

/** Returns the latest git tag (e.g. "v2.24.0"), or null if unavailable. */
function defaultResolveGitTag(): string | null {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

/**
 * Resolve the version string to emit.
 *
 * Uses the package.json version when it looks like a real semver. Falls back
 * to the latest git tag (leading "v" stripped) when the package.json version
 * is a semantic-release placeholder. Emits "unreleased" if git is unavailable
 * or has no tags — a missing label is acceptable; the placeholder string is not.
 */
function resolveVersion(
  rootDir: string,
  resolveGitTag: () => string | null,
): string {
  const pkgPath = path.join(rootDir, 'package.json')
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const pkg: unknown = JSON.parse(raw)
  if (
    !isRecord(pkg) ||
    typeof pkg.version !== 'string' ||
    pkg.version.length === 0
  ) {
    throw new Error(`package.json at ${pkgPath} is missing a version string.`)
  }

  if (!pkg.version.startsWith('0.0.0-')) {
    return pkg.version
  }

  const tag = resolveGitTag()
  if (tag === null) return 'unreleased'
  return tag.replace(/^v/, '')
}

/**
 * Compute stats for the given repo root. Pure function — reads from the
 * filesystem but does not write anything.
 *
 * Pass a custom `rootDir` to isolate in tests (mirrors generate-registry.ts).
 * Pass a custom `resolveGitTag` to avoid shelling out to git in tests.
 */
export function generateStats(
  rootDir: string,
  resolveGitTag: () => string | null = defaultResolveGitTag,
): Stats {
  return {
    skills: countSkills(rootDir),
    agents: countAgents(rootDir),
    components: countComponents(rootDir),
    version: resolveVersion(rootDir, resolveGitTag),
  }
}

/** Serialize stats to deterministic JSON (stable key order, trailing newline). */
export function serializeStats(stats: Stats): string {
  return `${JSON.stringify(stats, null, 2)}\n`
}

function main(rootDir: string, outputPath: string): void {
  const stats = generateStats(rootDir)
  const content = serializeStats(stats)

  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  fs.writeFileSync(outputPath, content)
  console.log(
    `Generated ${path.relative(rootDir, outputPath)} ` +
      `(skills: ${stats.skills}, agents: ${stats.agents}, ` +
      `components: ${stats.components}, version: ${stats.version})`,
  )
}

if (import.meta.main) {
  main(PROJECT_ROOT, OUTPUT_PATH)
}
