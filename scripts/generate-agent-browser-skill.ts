#!/usr/bin/env bun
/**
 * Sync the two artifacts derived from the pinned `agent-browser` npm devDependency:
 *
 *   1. `skills/agent-browser/SKILL.md` — vendored skill stub copied verbatim from
 *      `node_modules/agent-browser/skills/agent-browser/SKILL.md` with one deterministic
 *      transform: `hidden: true` is stripped from the YAML frontmatter so the skill is
 *      visible in Systematic's catalog (upstream's `hidden: true` is for its own
 *      discovery-install model and would fail the content-integrity gate).
 *
 *   2. `ATTRIBUTIONS.md` — the pinned-version references inside the
 *      `## vercel-labs/agent-browser — Apache-2.0` section are updated to match
 *      the version in `package.json` `devDependencies["agent-browser"]`. Only that
 *      section is touched; other attribution entries are untouched.
 *
 * The SINGLE source of truth for the pinned version is `package.json`
 * `devDependencies["agent-browser"]` — NOT node_modules, NOT hardcoded.
 *
 * Usage:
 *   bun scripts/generate-agent-browser-skill.ts          # Write both artifacts
 *   bun scripts/generate-agent-browser-skill.ts --check  # Exit 1 if either drifts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const SOURCE_PATH = path.join(
  PROJECT_ROOT,
  'node_modules',
  'agent-browser',
  'skills',
  'agent-browser',
  'SKILL.md',
)

const TARGET_PATH = path.join(
  PROJECT_ROOT,
  'skills',
  'agent-browser',
  'SKILL.md',
)

const ATTRIBUTIONS_PATH = path.join(PROJECT_ROOT, 'ATTRIBUTIONS.md')

const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json')

// ── Version resolution ────────────────────────────────────────────────────────

/**
 * Read the pinned agent-browser version from `package.json`
 * `devDependencies["agent-browser"]`. This is the single source of truth —
 * not node_modules, not hardcoded.
 *
 * Returns the bare semver string (e.g. `"0.33.0"`), stripped of any leading
 * range specifier (`^`, `~`). An exact pin (no specifier) is expected and
 * validated; a range specifier produces a warning but does not fail.
 */
export function readPinnedVersion(packageJsonPath?: string): string {
  const pkgPath = packageJsonPath ?? PACKAGE_JSON_PATH
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<
      string,
      unknown
    >
  } catch (err) {
    throw new Error(`Failed to read ${pkgPath}: ${(err as Error).message}`)
  }

  const devDeps = pkg.devDependencies
  if (
    typeof devDeps !== 'object' ||
    devDeps === null ||
    Array.isArray(devDeps)
  ) {
    throw new Error(
      'package.json is missing a devDependencies object. ' +
        'Add `"agent-browser": "<version>"` to devDependencies.',
    )
  }

  const raw = (devDeps as Record<string, unknown>)['agent-browser']
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      'agent-browser is not listed in package.json devDependencies. ' +
        'Add `"agent-browser": "<version>"` with an exact version pin.',
    )
  }

  // Strip leading range specifier (^, ~, >=, etc.) to get the bare version.
  const version = raw.replace(/^[^0-9]*/, '')
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(
      `package.json devDependencies["agent-browser"] value "${raw}" ` +
        'does not resolve to a semver string. Use an exact pin (e.g. "0.33.0").',
    )
  }

  return version
}

// ── SKILL.md generation ───────────────────────────────────────────────────────

/**
 * Read the upstream stub and apply the single deterministic transform:
 * strip the `hidden: true` line from YAML frontmatter.
 *
 * The transform is line-level — only an exact `hidden: true` line is removed.
 * Any other `hidden:` variant (with a different value, or indented) is left
 * intact, so the transform is safe across minor upstream frontmatter changes.
 */
function generateSkillContent(): string {
  if (!fs.existsSync(SOURCE_PATH)) {
    throw new Error(
      `Source file not found: ${SOURCE_PATH}\n` +
        'Run `bun install` to populate node_modules/agent-browser before generating.',
    )
  }

  const raw = fs.readFileSync(SOURCE_PATH, 'utf-8')
  return stripHiddenFromFrontmatter(raw)
}

/**
 * Strip the `hidden: true` line from the YAML frontmatter block only.
 * Returns the content unchanged if no frontmatter block is found or if
 * `hidden: true` is not present.
 */
export function stripHiddenFromFrontmatter(content: string): string {
  const FRONTMATTER_REGEX = /^---\n([\s\S]*?\n)---\n/

  const match = content.match(FRONTMATTER_REGEX)
  if (match === null) return content

  const frontmatter = match[1] ?? ''
  const rest = content.slice(match[0].length)

  const cleanedFrontmatter = frontmatter
    .split('\n')
    .filter((line) => !/^hidden:\s+true\s*$/.test(line))
    .join('\n')

  return `---\n${cleanedFrontmatter}---\n${rest}`
}

// ── ATTRIBUTIONS.md version sync ─────────────────────────────────────────────

/**
 * The heading that delimits the agent-browser attribution section in
 * ATTRIBUTIONS.md. The version sync is scoped to this section only.
 */
const ATTRIBUTIONS_SECTION_HEADING = '## vercel-labs/agent-browser — Apache-2.0'

/**
 * Apply the pinned version to ATTRIBUTIONS.md in-memory, scoped strictly to
 * the `## vercel-labs/agent-browser — Apache-2.0` section.
 *
 * Two substitutions within that section only:
 *   - `` `v<semver>` ``         → `` `v<version>` ``
 *   - `` `agent-browser@<semver>` `` → `` `agent-browser@<version>` ``
 *
 * No other text is altered. The Apache license body is untouched (it uses
 * "Version 2.0" without backticks and without the semver `vX.Y.Z` form).
 */
export function applyVersionToAttributions(
  content: string,
  version: string,
): string {
  const startIdx = content.indexOf(ATTRIBUTIONS_SECTION_HEADING)
  if (startIdx === -1) {
    throw new Error(
      `ATTRIBUTIONS.md is missing the "${ATTRIBUTIONS_SECTION_HEADING}" section. ` +
        'Run `bun run agent-browser:build` to verify the file is intact.',
    )
  }

  // Find the start of the next `## ` heading after the section, or EOF.
  const searchFrom = startIdx + ATTRIBUTIONS_SECTION_HEADING.length
  const nextHeadingOffset = content.indexOf('\n## ', searchFrom)
  const endIdx =
    nextHeadingOffset === -1 ? content.length : nextHeadingOffset + 1

  const before = content.slice(0, startIdx)
  const section = content.slice(startIdx, endIdx)
  const after = content.slice(endIdx)

  const updatedSection = section
    .replace(/`v\d+\.\d+\.\d+`/g, `\`v${version}\``)
    .replace(/`agent-browser@\d+\.\d+\.\d+`/g, `\`agent-browser@${version}\``)

  return before + updatedSection + after
}

// ── Comparison helper ─────────────────────────────────────────────────────────

/**
 * Normalize content for comparison: collapse CRLF and trim trailing whitespace.
 */
export function normalizeForCompare(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

// ── Drift check ───────────────────────────────────────────────────────────────

/**
 * Check both artifacts for drift. Returns `{ok, message}` with all failures
 * aggregated so a stale-both scenario surfaces all errors at once.
 *
 * Artifact 1 — skills/agent-browser/SKILL.md:
 *   Regenerated from node_modules/agent-browser and compared to committed file.
 *
 * Artifact 2 — ATTRIBUTIONS.md (version references only):
 *   The pinned version from package.json is applied in-memory and compared to
 *   the committed ATTRIBUTIONS.md. This catches the silent-staleness case where
 *   the stub content is byte-identical across a version bump but ATTRIBUTIONS
 *   still references the old version.
 */
function checkDrift(): { ok: boolean; message: string } {
  const failures: string[] = []

  // ── Artifact 1: SKILL.md ─────────────────────────────────────────────────
  let skillContent = ''
  try {
    skillContent = generateSkillContent()
  } catch (err) {
    failures.push((err as Error).message)
  }

  if (skillContent.length > 0) {
    if (!fs.existsSync(TARGET_PATH)) {
      failures.push(
        'skills/agent-browser/SKILL.md does not exist. ' +
          'Run `bun run agent-browser:build` to create it.',
      )
    } else {
      const committed = fs.readFileSync(TARGET_PATH, 'utf-8')
      if (
        normalizeForCompare(committed) !== normalizeForCompare(skillContent)
      ) {
        failures.push(
          'skills/agent-browser/SKILL.md is out of date with the pinned agent-browser package. ' +
            'Run `bun run agent-browser:build` to regenerate it.',
        )
      }
    }
  }

  // ── Artifact 2: ATTRIBUTIONS.md version references ───────────────────────
  try {
    const version = readPinnedVersion()
    const currentAttributions = fs.readFileSync(ATTRIBUTIONS_PATH, 'utf-8')
    const expectedAttributions = applyVersionToAttributions(
      currentAttributions,
      version,
    )
    if (
      normalizeForCompare(currentAttributions) !==
      normalizeForCompare(expectedAttributions)
    ) {
      failures.push(
        `ATTRIBUTIONS.md version references are out of date ` +
          `(committed version differs from pinned agent-browser@${version}). ` +
          'Run `bun run agent-browser:build` to sync them.',
      )
    }
  } catch (err) {
    failures.push((err as Error).message)
  }

  if (failures.length === 0) {
    return {
      ok: true,
      message:
        'skills/agent-browser/SKILL.md and ATTRIBUTIONS.md are up to date.',
    }
  }

  return { ok: false, message: failures.join('\n\n') }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2)
  const checkMode = args.includes('--check')

  if (checkMode) {
    const result = checkDrift()
    if (result.ok) {
      console.log(result.message)
      process.exit(0)
    }
    console.error(`Error: ${result.message}`)
    process.exit(1)
  }

  // Generate mode: write SKILL.md and sync ATTRIBUTIONS.md.
  let skillContent: string
  try {
    skillContent = generateSkillContent()
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  // ── Write SKILL.md ────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(TARGET_PATH), { recursive: true })

  let skillUpdated = false
  try {
    const existing = fs.readFileSync(TARGET_PATH, 'utf-8')
    if (normalizeForCompare(existing) !== normalizeForCompare(skillContent)) {
      skillUpdated = true
    }
  } catch {
    skillUpdated = true
  }

  if (skillUpdated) {
    fs.writeFileSync(TARGET_PATH, skillContent, 'utf-8')
    console.log(
      'Generated skills/agent-browser/SKILL.md from pinned agent-browser package.',
    )
  } else {
    console.log('skills/agent-browser/SKILL.md is already up to date.')
  }

  // ── Sync ATTRIBUTIONS.md version references ───────────────────────────────
  let version: string
  try {
    version = readPinnedVersion()
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  let currentAttributions: string
  try {
    currentAttributions = fs.readFileSync(ATTRIBUTIONS_PATH, 'utf-8')
  } catch (err) {
    console.error(`Failed to read ATTRIBUTIONS.md: ${(err as Error).message}`)
    process.exit(1)
  }

  let expectedAttributions: string
  try {
    expectedAttributions = applyVersionToAttributions(
      currentAttributions,
      version,
    )
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  if (
    normalizeForCompare(currentAttributions) !==
    normalizeForCompare(expectedAttributions)
  ) {
    fs.writeFileSync(ATTRIBUTIONS_PATH, expectedAttributions, 'utf-8')
    console.log(
      `Synced ATTRIBUTIONS.md version references to agent-browser@${version}.`,
    )
  } else {
    console.log(
      `ATTRIBUTIONS.md version references already match agent-browser@${version}.`,
    )
  }
}

if (import.meta.main) {
  main()
}
