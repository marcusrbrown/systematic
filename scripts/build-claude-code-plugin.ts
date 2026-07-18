#!/usr/bin/env bun
/**
 * Build Claude Code Plugin Bundle
 *
 * Generates a self-contained `claude-code/` plugin bundle from the existing
 * `skills/` + `agents/` source, mirroring the `build-registry.ts` /
 * `generate-registry.ts` codegen precedent: walk source, emit a self-contained
 * artifact, gate with a `--check` drift mode.
 *
 * The bundle is a STATIC artifact — no runtime TypeScript ships inside it.
 * CC copies plugins to a per-session cache, so every file must be
 * self-contained (content copies, never symlinks back to skills/).
 *
 * Output structure:
 *   claude-code/.claude-plugin/plugin.json   — hand-written manifest
 *   claude-code/output-styles/systematic.md  — using-systematic body + CC profile + skill catalog
 *   claude-code/hooks/hooks.json             — declarative SessionStart state (static printf)
 *   claude-code/skills/<name>/SKILL.md(+subfiles) — copied verbatim from skills/
 *   claude-code/agents/<name>.md             — flattened from agents/<category>/<name>.md
 *
 * Usage:
 *   bun scripts/build-claude-code-plugin.ts             # Full build, writes claude-code/
 *   bun scripts/build-claude-code-plugin.ts --check     # Drift check, exits non-zero on divergence
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAgentsInDir } from '../src/lib/agents.js'
import { formatFrontmatter, parseFrontmatter } from '../src/lib/frontmatter.js'
import { renderCatalogVerbose } from '../src/lib/skill-catalog.js'
import { findSkillsInDir } from '../src/lib/skills.js'
import { walkDir } from '../src/lib/walk-dir.js'
import { isExcludedFile } from './generate-registry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

/** SessionStart `additionalContext` cap per Claude Code hooks docs. */
export const HOOK_PAYLOAD_CAP = 10000

/**
 * Tagged error for build-detected failures (missing source, stem collisions).
 * Plain Error + tag keeps the codebase class-free; callers detect via `code` field.
 */
export type BuildError = Error & { code: 'BUILD_ERROR' }

function buildError(message: string): BuildError {
  return Object.assign(new Error(message), { code: 'BUILD_ERROR' as const })
}

function isBuildError(err: unknown): err is BuildError {
  return (
    err instanceof Error && (err as { code?: string }).code === 'BUILD_ERROR'
  )
}

function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join('/')
}

function readPackageVersion(rootDir: string): string {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    )
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof (parsed as { version: unknown }).version === 'string'
    ) {
      const version = (parsed as { version: string }).version
      if (version.length > 0 && !version.includes('semantic-release')) {
        return version
      }
    }
  } catch {
    // fall through to default
  }
  return '0.0.1'
}

export interface ClaudePluginManifest {
  name: string
  version: string
  description: string
  author: string
}

/** Hand-written plugin manifest — only `name` is strictly required by CC. */
export function buildPluginManifest(rootDir: string): ClaudePluginManifest {
  return {
    name: 'systematic',
    version: readPackageVersion(rootDir),
    description: 'Structured engineering workflows for Claude Code.',
    author: 'Marcus R. Brown <human@fro.bot>',
  }
}

/**
 * Composes the output-style body: using-systematic SKILL.md body + the CC
 * capability profile + the rendered skill catalog. Same composition as
 * `getBootstrapContent` (src/lib/bootstrap.ts) minus the `<SYSTEMATIC_WORKFLOWS>`
 * XML wrapper and minus the generic skill-usage template (CC ships no
 * `systematic_skill` tool, so that OpenCode/Pi-specific template does not apply).
 *
 * The enforcement text is read from `skills/using-systematic/SKILL.md` directly
 * (not duplicated) so it cannot drift from the single source of truth.
 */
export function buildOutputStyleContent(rootDir: string): string {
  const usingSystematicPath = path.join(
    rootDir,
    'skills/using-systematic/SKILL.md',
  )
  if (!fs.existsSync(usingSystematicPath)) {
    throw buildError(
      `Missing ${path.relative(rootDir, usingSystematicPath)}; cannot render output style.`,
    )
  }

  const profilePath = path.join(
    rootDir,
    'skills/using-systematic/references/claude-code-profile.md',
  )
  if (!fs.existsSync(profilePath)) {
    throw buildError(
      `Missing ${path.relative(rootDir, profilePath)}; cannot render output style.`,
    )
  }

  const fullContent = fs.readFileSync(usingSystematicPath, 'utf8')
  const { body } = parseFrontmatter(fullContent)
  const usingSystematicBody = body.trim()

  const profileContent = fs.readFileSync(profilePath, 'utf8').trim()

  const catalog = renderCatalogVerbose({
    bundledSkillsDir: path.join(rootDir, 'skills'),
    disabledSkills: [],
    includeLocations: false,
  })
  const catalogSection = catalog.length > 0 ? `\n\n${catalog}` : ''

  const body_ = `You have access to structured engineering workflows via the Systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do not load "using-systematic" again - that would be redundant.**

${usingSystematicBody}

${profileContent}${catalogSection}`

  const frontmatter = formatFrontmatter({
    name: 'systematic',
    description:
      'Structured engineering workflows for Claude Code via the Systematic plugin.',
    'force-for-plugin': true,
  })

  return `${frontmatter}\n\n${body_}\n`
}

/**
 * Declarative SessionStart facts: Systematic active, version, skill/agent
 * counts and names. Facts only — no imperative directives (Claude Code
 * refuses imperative hook content as prompt injection). Falls back to
 * counts-only when the full name list would exceed the cap, rather than
 * truncating mid-string.
 */
export function buildHookFacts(rootDir: string): string {
  const version = readPackageVersion(rootDir)
  const skillNames = findSkillsInDir(path.join(rootDir, 'skills'))
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b))
  const agentNames = findAgentsInDir(path.join(rootDir, 'agents'))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b))

  const full = `Systematic v${version} active. ${skillNames.length} skills available: ${skillNames.join(', ')}. ${agentNames.length} agents available: ${agentNames.join(', ')}.`
  if (full.length <= HOOK_PAYLOAD_CAP) return full

  const reduced = `Systematic v${version} active. ${skillNames.length} skills available. ${agentNames.length} agents available.`
  if (reduced.length <= HOOK_PAYLOAD_CAP) return reduced

  throw buildError(
    `Declarative hook payload exceeds ${HOOK_PAYLOAD_CAP} chars even after reducing to counts-only (${reduced.length} chars).`,
  )
}

/** Single-quotes a shell argument, escaping embedded single quotes. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface ClaudeHooksJson {
  hooks: {
    SessionStart: Array<{
      matcher: string
      hooks: Array<{ type: 'command'; command: string }>
    }>
  }
}

/**
 * Declarative SessionStart command hook. Static `printf` of facts — no
 * runtime JS in the bundle, sidestepping the hook-throw-swallowing failure mode.
 */
export function buildHooksJson(rootDir: string): ClaudeHooksJson {
  const facts = buildHookFacts(rootDir)
  const command = `printf '%s' ${shellSingleQuote(facts)}`

  return {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command }],
        },
      ],
    },
  }
}

/** Copies every skill directory's files verbatim, keyed by output-relative path under `skills/`. */
export function collectSkillFiles(rootDir: string): Map<string, Buffer> {
  const skillsDir = path.join(rootDir, 'skills')
  const skills = findSkillsInDir(skillsDir)
  const result = new Map<string, Buffer>()

  for (const skill of skills) {
    const name = path.basename(skill.path)
    const entries = walkDir(skill.path, {
      maxDepth: 20,
      filter: (e) => !e.isDirectory && !isExcludedFile(e.path),
    })

    for (const entry of entries) {
      const relToSkillDir = toPosixPath(path.relative(skill.path, entry.path))
      const outRelPath = `skills/${name}/${relToSkillDir}`
      result.set(outRelPath, fs.readFileSync(entry.path))
    }
  }

  return result
}

export interface FlattenedAgent {
  stem: string
  sourceFile: string
  content: Buffer
}

/**
 * Flattens `agents/<category>/<name>.md` → a stem-keyed list, enforcing
 * global stem uniqueness (mirrors `checkAgentStemUniqueness` in
 * scripts/content-integrity.ts). Claude Code accepts Systematic's agent
 * frontmatter as-is, so this is a pure hierarchy move — no frontmatter
 * injection or stripping.
 */
export function flattenAgents(rootDir: string): FlattenedAgent[] {
  const agentsDir = path.join(rootDir, 'agents')
  const agents = findAgentsInDir(agentsDir)

  const byStem = new Map<string, string[]>()
  for (const agent of agents) {
    const files = byStem.get(agent.name) ?? []
    files.push(agent.file)
    byStem.set(agent.name, files)
  }

  const collisions = [...byStem.entries()].filter(
    ([, files]) => files.length > 1,
  )
  if (collisions.length > 0) {
    const detail = collisions
      .map(
        ([stem, files]) =>
          `  - "${stem}": ${files.map((f) => path.relative(rootDir, f)).join(', ')}`,
      )
      .join('\n')
    throw buildError(
      `Agent stem collision(s) detected — the flatten step requires globally unique stems:\n${detail}`,
    )
  }

  return agents.map((agent) => ({
    stem: agent.name,
    sourceFile: agent.file,
    content: fs.readFileSync(agent.file),
  }))
}

/**
 * Generates the full set of `claude-code/`-relative files in memory. Pure
 * function of `rootDir` — throws BuildError on missing source or stem
 * collisions, never emits a silent empty bundle.
 */
export function generatePluginFiles(rootDir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()

  files.set(
    '.claude-plugin/plugin.json',
    Buffer.from(`${JSON.stringify(buildPluginManifest(rootDir), null, 2)}\n`),
  )

  files.set(
    'output-styles/systematic.md',
    Buffer.from(buildOutputStyleContent(rootDir)),
  )

  files.set(
    'hooks/hooks.json',
    Buffer.from(`${JSON.stringify(buildHooksJson(rootDir), null, 2)}\n`),
  )

  for (const [relPath, content] of collectSkillFiles(rootDir)) {
    files.set(relPath, content)
  }

  for (const agent of flattenAgents(rootDir)) {
    files.set(`agents/${agent.stem}.md`, agent.content)
  }

  return files
}

/** Writes a generated file map to `outDir`, clearing any prior contents first. */
export function writePluginFiles(
  files: Map<string, Buffer>,
  outDir: string,
): void {
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
  for (const [relPath, content] of files) {
    const outPath = path.join(outDir, relPath)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, content)
  }
}

export interface DriftResult {
  inSync: boolean
  missing: string[]
  extra: string[]
  differing: string[]
}

/**
 * Regenerates the bundle in memory and diffs it against the committed
 * `claudeCodeDir` — mirrors `generate-registry.ts --check` semantics.
 */
export function checkDrift(
  rootDir: string,
  claudeCodeDir: string,
): DriftResult {
  const generated = generatePluginFiles(rootDir)

  const onDisk = new Map<string, Buffer>()
  if (fs.existsSync(claudeCodeDir)) {
    const entries = walkDir(claudeCodeDir, {
      maxDepth: 20,
      filter: (e) => !e.isDirectory,
    })
    for (const entry of entries) {
      const rel = toPosixPath(path.relative(claudeCodeDir, entry.path))
      onDisk.set(rel, fs.readFileSync(entry.path))
    }
  }

  const missing: string[] = []
  const differing: string[] = []
  for (const [relPath, content] of generated) {
    const existing = onDisk.get(relPath)
    if (existing === undefined) {
      missing.push(relPath)
      continue
    }
    if (!existing.equals(content)) {
      differing.push(relPath)
    }
  }

  const generatedPaths = new Set(generated.keys())
  const extra = [...onDisk.keys()].filter((p) => !generatedPaths.has(p))

  return {
    inSync:
      missing.length === 0 && extra.length === 0 && differing.length === 0,
    missing: missing.sort((a, b) => a.localeCompare(b)),
    extra: extra.sort((a, b) => a.localeCompare(b)),
    differing: differing.sort((a, b) => a.localeCompare(b)),
  }
}

function parseArgs(argv: string[]): { check: boolean } {
  return { check: argv.slice(2).includes('--check') }
}

function reportDriftResult(
  result: DriftResult,
  claudeCodeDir: string,
  rootDir: string,
): never {
  console.error(
    `Error: ${path.relative(rootDir, claudeCodeDir)}/ is out of date. Run \`bun scripts/build-claude-code-plugin.ts\` to regenerate it.`,
  )
  if (result.missing.length > 0) {
    console.error(`  Missing: ${result.missing.join(', ')}`)
  }
  if (result.extra.length > 0) {
    console.error(`  Extra (stale): ${result.extra.join(', ')}`)
  }
  if (result.differing.length > 0) {
    console.error(`  Differing: ${result.differing.join(', ')}`)
  }
  process.exit(1)
}

function runCheck(rootDir: string, claudeCodeDir: string): void {
  let result: DriftResult
  try {
    result = checkDrift(rootDir, claudeCodeDir)
  } catch (err) {
    if (isBuildError(err)) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  if (result.inSync) {
    console.log(`${path.relative(rootDir, claudeCodeDir)}/ is up to date.`)
    process.exit(0)
  }

  reportDriftResult(result, claudeCodeDir, rootDir)
}

function main(rootDir: string): void {
  const { check } = parseArgs(process.argv)
  const claudeCodeDir = path.join(rootDir, 'claude-code')

  if (check) {
    runCheck(rootDir, claudeCodeDir)
    return
  }

  let files: Map<string, Buffer>
  try {
    files = generatePluginFiles(rootDir)
  } catch (err) {
    if (isBuildError(err)) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  writePluginFiles(files, claudeCodeDir)

  const hookPayloadLen = buildHookFacts(rootDir).length
  console.log(
    `Generated ${path.relative(rootDir, claudeCodeDir)}/ (${files.size} files)`,
  )
  console.log(`Hook payload: ${hookPayloadLen} chars (cap ${HOOK_PAYLOAD_CAP})`)
}

// Only run main() when this file is invoked directly (not when imported by tests).
if (import.meta.main) {
  main(PROJECT_ROOT)
}
