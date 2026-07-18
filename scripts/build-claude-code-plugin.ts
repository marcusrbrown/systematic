#!/usr/bin/env bun
/**
 * Build Claude Code Plugin Bundle
 *
 * Generates a self-contained, EPHEMERAL `claude-code/` plugin bundle from the
 * existing `skills/` + `agents/` source. The bundle is a gitignored build
 * artifact — never committed, always regenerated. Source stays canonical and
 * phantom-validated (scripts/content-integrity.ts); this build applies a
 * build-time identifier translation so generated skill/agent bodies reference
 * Claude Code's real plugin-namespaced identifiers (`systematic:<skill-dir>`,
 * `systematic:<agent-stem>`) instead of Systematic's internal `ce:<name>` /
 * `systematic:<category>:<name>` source forms.
 *
 * The bundle is a STATIC artifact — no runtime TypeScript ships inside it.
 * CC copies plugins to a per-session cache, so every file must be
 * self-contained (content copies, never symlinks back to skills/).
 *
 * Output structure:
 *   claude-code/.claude-plugin/plugin.json   — hand-written manifest
 *   claude-code/output-styles/systematic.md  — using-systematic body + CC profile (translated)
 *   claude-code/hooks/hooks.json             — declarative SessionStart state (static printf)
 *   claude-code/skills/<name>/SKILL.md(+subfiles) — copied + translated from skills/
 *   claude-code/agents/<name>.md             — flattened + translated from agents/<category>/<name>.md
 *
 * After translation, `checkGeneratedNamespace` validates the built bundle
 * contains no leftover source-namespace forms and every bare
 * `systematic:<name>` resolves to a bundled skill or agent — failing the
 * build (BuildError) rather than shipping a dangling reference.
 *
 * Usage:
 *   bun scripts/build-claude-code-plugin.ts   # Full build, writes claude-code/ (gitignored staging dir)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAgentsInDir } from '../src/lib/agents.js'
import { formatFrontmatter, parseFrontmatter } from '../src/lib/frontmatter.js'
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

export interface ClaudePluginManifest {
  name: string
  version: string
  description: string
  author: string
}

/** Hand-written plugin manifest — only `name` is strictly required by CC. */
export function buildPluginManifest(_rootDir: string): ClaudePluginManifest {
  return {
    name: 'systematic',
    version: '0.1.0',
    description: 'Structured engineering workflows for Claude Code.',
    author: 'Marcus R. Brown <human@fro.bot>',
  }
}

/**
 * Composes the output-style body: using-systematic SKILL.md body + the CC
 * capability profile. No hand-inlined skill catalog — Claude Code's native
 * Skill tool discovers bundled skills at runtime and exposes their real,
 * plugin-namespaced names, so a generated catalog here would only drift and
 * mislead (see docs/plans/2026-07-17-002 corrective rework). Same composition
 * as `getBootstrapContent` (src/lib/bootstrap.ts) minus the
 * `<SYSTEMATIC_WORKFLOWS>` XML wrapper and minus the generic skill-usage
 * template (CC ships no `systematic_skill` tool, so that OpenCode/Pi-specific
 * template does not apply).
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

  const body_ = `You have access to structured engineering workflows via the Systematic plugin.

**IMPORTANT: The using-systematic skill content is included below. It is ALREADY LOADED - you are currently following it. Do not load "using-systematic" again - that would be redundant.**

${usingSystematicBody}

${profileContent}`

  const frontmatter = formatFrontmatter({
    name: 'systematic',
    description:
      'Structured engineering workflows for Claude Code via the Systematic plugin.',
    'force-for-plugin': true,
  })

  return `${frontmatter}\n\n${body_}\n`
}

/**
 * Declarative SessionStart facts: Systematic active, skill/agent counts.
 * No version (package.json has no real version pre-publish) and no
 * enumerated name lists (names drift; counts don't). Facts only — no
 * imperative directives (Claude Code refuses imperative hook content as
 * prompt injection).
 */
export function buildHookFacts(rootDir: string): string {
  const skillCount = findSkillsInDir(path.join(rootDir, 'skills')).length
  const agentCount = findAgentsInDir(path.join(rootDir, 'agents')).length

  const facts = `Systematic active. ${skillCount} skills and ${agentCount} subagents are available via Claude Code's native Skill and subagent tools; the "systematic" output style carries workflow-enforcement discipline.`
  if (facts.length <= HOOK_PAYLOAD_CAP) return facts

  throw buildError(
    `Declarative hook payload exceeds ${HOOK_PAYLOAD_CAP} chars (${facts.length} chars).`,
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
 * Symbol table of Claude Code (CC) identifiers derivable from source: every
 * bundled skill directory name and every flattened agent stem. Built fresh
 * per build from the same discovery functions used to emit the bundle, so it
 * can never drift from what actually ships.
 */
export interface SourceInventory {
  skillDirs: Set<string>
  agentStems: Set<string>
}

export function buildSourceInventory(rootDir: string): SourceInventory {
  const skills = findSkillsInDir(path.join(rootDir, 'skills'))
  const agents = findAgentsInDir(path.join(rootDir, 'agents'))

  return {
    skillDirs: new Set(skills.map((s) => path.basename(s.path))),
    agentStems: new Set(agents.map((a) => a.name)),
  }
}

/**
 * Candidate identifier tokens in generated bodies: bare `ce:<x>` source refs,
 * qualified `systematic:<category>:<name>` agent refs, and bare
 * `systematic:<name>` refs. Boundary-aware (word boundaries only) so partial
 * matches inside unrelated words are never touched.
 */
const IDENTIFIER_TOKEN_RE =
  /\b(?:ce:[a-z0-9-]+|systematic:[a-z0-9-]+(?::[a-z0-9-]+)?)\b/g

/**
 * Rewrites source identifier tokens to their Claude Code plugin-namespaced
 * form, one pass, inventory-verified — never a blind string replace.
 *
 *   ce:<x>                          -> systematic:ce-<x>   (iff skills/ce-<x>/ exists)
 *   systematic:<category>:<name>    -> systematic:<name>   (iff agent stem exists)
 *   systematic:<name>                (bare, left as-is; validated by
 *                                     checkGeneratedNamespace, not rewritten here)
 *
 * Unknown/unresolvable candidates are left untouched deliberately — rewriting
 * to a guess would fabricate an identifier that doesn't exist in the bundle.
 * `checkGeneratedNamespace` catches anything left unresolved.
 */
export function translateIdentifiers(
  content: string,
  inventory: SourceInventory,
): string {
  return content.replace(IDENTIFIER_TOKEN_RE, (match) => {
    if (match.startsWith('ce:')) {
      const suffix = match.slice('ce:'.length)
      const dir = `ce-${suffix}`
      return inventory.skillDirs.has(dir) ? `systematic:${dir}` : match
    }

    const rest = match.slice('systematic:'.length)
    const parts = rest.split(':')
    if (parts.length === 2) {
      const name = parts[1] as string
      return inventory.agentStems.has(name) ? `systematic:${name}` : match
    }

    // Bare systematic:<name> — membership validated by checkGeneratedNamespace.
    return match
  })
}

/** Files whose bodies carry identifier refs subject to translation + the integrity gate. */
function isTranslatableFile(relPath: string): boolean {
  return (
    /^skills\/[^/]+\/.*\.md$/.test(relPath) ||
    /^agents\/[^/]+\.md$/.test(relPath) ||
    relPath === 'output-styles/systematic.md'
  )
}

/**
 * Applies identifier translation to every translatable generated file, plus
 * normalizes each SKILL.md's frontmatter `name` to the skill directory
 * basename (CC derives invocation from the dir name; the frontmatter `name`
 * is only a display label, so misalignment would show `ce:brainstorm` while
 * requiring `/systematic:ce-brainstorm`). Non-translatable/binary files pass
 * through byte-for-byte.
 */
export function translateBundle(
  files: Map<string, Buffer>,
  inventory: SourceInventory,
): Map<string, Buffer> {
  const result = new Map<string, Buffer>()

  for (const [relPath, content] of files) {
    if (!isTranslatableFile(relPath)) {
      result.set(relPath, content)
      continue
    }

    let text = content.toString('utf8')

    const skillMatch = relPath.match(/^skills\/([^/]+)\/SKILL\.md$/)
    if (skillMatch) {
      const dirName = skillMatch[1] as string
      const { data, body, hadFrontmatter } =
        parseFrontmatter<Record<string, unknown>>(text)
      if (hadFrontmatter) {
        text = `${formatFrontmatter({ ...data, name: dirName })}\n\n${body.trim()}\n`
      }
    }

    text = translateIdentifiers(text, inventory)
    result.set(relPath, Buffer.from(text))
  }

  return result
}

const CE_FORM_RE = /\bce:[a-z0-9-]+\b/g
const QUALIFIED_RE = /\bsystematic:[a-z0-9-]+:[a-z0-9-]+\b/g
const BARE_RE = /\bsystematic:[a-z0-9-]+\b/g

/**
 * Post-translation integrity gate — the CC equivalent of
 * `checkReferenceIntegrity` in scripts/content-integrity.ts. Fails the build
 * (never emits a bundle with a dangling/untranslated reference) when:
 *   - a source `ce:<name>` form survived translation,
 *   - a qualified `systematic:<category>:<name>` form survived translation,
 *   - a bare `systematic:<name>` doesn't resolve to a bundled skill or agent.
 */
export function checkGeneratedNamespace(
  files: Map<string, Buffer>,
  inventory: SourceInventory,
): void {
  const validTargets = new Set<string>([
    ...[...inventory.skillDirs].map((d) => `systematic:${d}`),
    ...[...inventory.agentStems].map((s) => `systematic:${s}`),
  ])

  for (const [relPath, content] of files) {
    if (!isTranslatableFile(relPath)) continue
    const text = content.toString('utf8')

    const ceMatch = text.match(CE_FORM_RE)
    if (ceMatch) {
      throw buildError(
        `${relPath}: untranslated source identifier "${ceMatch[0]}" leaked into the generated bundle.`,
      )
    }

    const qualifiedMatch = text.match(QUALIFIED_RE)
    if (qualifiedMatch) {
      throw buildError(
        `${relPath}: untranslated qualified identifier "${qualifiedMatch[0]}" leaked into the generated bundle.`,
      )
    }

    for (const match of text.matchAll(BARE_RE)) {
      const id = match[0]
      if (!validTargets.has(id)) {
        throw buildError(
          `${relPath}: identifier "${id}" does not resolve to any bundled skill or agent.`,
        )
      }
    }
  }
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

  const inventory = buildSourceInventory(rootDir)
  const translated = translateBundle(files, inventory)
  checkGeneratedNamespace(translated, inventory)

  return translated
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

function main(rootDir: string): void {
  const claudeCodeDir = path.join(rootDir, 'claude-code')

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
