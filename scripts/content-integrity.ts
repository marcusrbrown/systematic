#!/usr/bin/env bun
/**
 * Content-Integrity Gate
 *
 * Enforces content invariants across Systematic's shipped assets:
 *
 * 1. **Cross-skill reference integrity** — every `systematic:<category>:<name>`
 *    reference in bundled skills and agents resolves to an actual
 *    `agents/<category>/<name>.md` file. Catches phantom dispatch directives left
 *    over from sync operations or sub-agent bulk edits.
 *
 * 2. **Sub-file reference integrity** — every `references/foo.md`, `scripts/foo.sh`,
 *    `templates/foo.md`, or `assets/foo.md` mentioned in a
 *    `skills/<name>/SKILL.md` resolves to a real file in that skill's directory.
 *    Catches drift from CEP syncs that imported the SKILL.md but missed the
 *    referenced sub-files (the failure mode that motivated this PR).
 *
 * 3. **Banned-pattern scan** — a fixed list of CC/CEP strings (branding, tool
 *    names, plugin prefix, paths, env vars) appears only inside documented
 *    allowlist entries. Catches accidental reintroduction of Claude Code or
 *    Compound Engineering refs after the v2.4.0 divorce.
 *
 * 4. **Skill frontmatter integrity** — bundled skills declare required fields
 *    and use only frontmatter keys recognized by the runtime loader.
 *
 * 5. **Agent model portability** — bundled agents inherit the user's configured
 *    model instead of hardcoding provider-specific model IDs.
 *
 * 6. **Agent mode** — bundled agents must declare `mode: subagent` explicitly so
 *    they remain invisible to primary-agent discovery regardless of future
 *    OpenCode default changes.
 *
 * 7. **Agent temperature** — bundled agents must declare an explicit `temperature:`
 * as a finite number in frontmatter. A missing, null, or non-numeric value is
 * treated as absent — there is no runtime fallback — so only a real finite
 * number satisfies this invariant.
 *
 * 8. **Skill argument-hint** — bundled skills whose body references the literal
 *    `$ARGUMENTS` outside fenced code blocks or blockquotes must declare a non-empty
 *    `argument-hint` field in frontmatter. Fenced code blocks are stripped before
 *    scanning so skills that only document the placeholder are not flagged.
 *
 * 9. **Dispatch identifier integrity** — every `subagent_type` value resolves to
 *    a bundled agent stem, and inline-code near-misses of bundled agent stems
 *    are rejected. Bundled examples must name agents this package ships.
 *
 * 10. **Plugin hook parity** — named contributor-facing root documents that
 *     assert the registered hook set must match the keys returned by the plugin
 *     entry point.
 *
 * 11. **Architecture codemap completeness** — every TypeScript module directly
 *     under `src/lib/` must appear in the `ARCHITECTURE.md` codemap or in its
 *     visible codemap-exclusion list, and every codemap entry must resolve to a
 *     module on disk.
 *
 * 13. **Migrated skill identifiers** — skills marked
 *     `metadata['harness-portability'] === 'neutral-v1'` must use neutral
 *     lexical vocabulary; exact harness syntax belongs in the harness profiles.
 *
 * Scope is narrow by design: `skills/**\/*.md`, `agents/**\/*.md`, and
 * `src/**\/*.ts` for the full invariant suite. The named root documents
 * `ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`, and
 * `.github/copilot-instructions.md` are additionally scanned for plugin hook
 * parity because they are contributor-facing inventories of the system's
 * registered surface; they are not merged into the full markdown scan.
 * Additionally, `docs/solutions/**\/*.md` is scanned for frontmatter parse-safety
 * only (flags any unquoted inline comment — whitespace-before-`#` or value-start
 * `#` — in frontmatter; remediation is to quote the value or remove the comment).
 * The gate does not scan `.opencode/`, `dist/`, `node_modules/`, `registry/`, or
 * markdown files under `src/` — those intentionally contain historical or
 * documented CC/CEP references.
 * Solution docs are intentionally excluded from banned-pattern enforcement
 * because historical docs may legitimately reference CC/CEP terms.
 *
 * Agent categories are discovered at runtime from `agents/` subdirectories so
 * adding a new category auto-extends coverage without a regex update.
 *
 * Usage:
 *   bun scripts/content-integrity.ts            # Run against the repo; exit 0/1
 *   bun scripts/content-integrity.ts --verbose  # Also print exempt hits + scan stats
 *
 * See docs/plans/2026-04-18-001-feat-content-integrity-gate-plan.md for the
 * design rationale; docs/brainstorms/2026-04-18-infra-improvements-requirements.md
 * for the originating requirements.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isValidAgentColor,
  OPENCODE_AGENT_COLOR_TOKENS,
} from '../src/lib/agent-colors.js'
import {
  BUNDLED_AGENT_NAMES,
  BUNDLED_AGENT_QUALIFIED_IDS,
  BUNDLED_SKILL_NAMES,
} from '../src/lib/bundled-names.js'
import {
  extractFrontmatterBlock,
  parseFrontmatter,
} from '../src/lib/frontmatter.js'
import {
  REMOVED_BUNDLED_AGENT_NAMES,
  REMOVED_BUNDLED_SKILL_NAMES,
} from '../src/lib/removed-names.js'
import { SKILL_FRONTMATTER_FIELDS } from '../src/lib/skills.js'
import { walkDir } from '../src/lib/walk-dir.js'

// ---------------------------------------------------------------------------
// Banned-pattern list
// ---------------------------------------------------------------------------

/**
 * Fixed list of CC/CEP strings the gate scans for. Every entry is a literal
 * substring match (case-sensitive). Edits to this list require a corresponding
 * review of `scripts/.drift-allowlist.json` — adding a pattern will surface
 * hits across the catalog; removing one silently widens the gate.
 */
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal ${CLAUDE_PLUGIN_ROOT} string is what we scan for.
export const BANNED_PATTERNS = [
  'Claude Code',
  'TaskCreate',
  'AskUserQuestion',
  'compound-engineering:',
  'CLAUDE.md',
  '${CLAUDE_PLUGIN_ROOT}',
  '.claude/',
  '.context/compound-engineering/',
] as const
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal ${CLAUDE_PLUGIN_ROOT} string is what we scan for.

export type BannedPattern = (typeof BANNED_PATTERNS)[number]

function isBannedPattern(value: unknown): value is BannedPattern {
  return (
    typeof value === 'string' &&
    (BANNED_PATTERNS as readonly string[]).includes(value)
  )
}

// ---------------------------------------------------------------------------
// Allowlist types
// ---------------------------------------------------------------------------

export interface AllowlistEntry {
  pathGlob: string
  patterns: BannedPattern[]
  reason: string
}

export interface AllowlistFile {
  exemptions: AllowlistEntry[]
}

export interface AllowlistWarning {
  kind: 'zero-match' | 'broad-pathglob'
  pathGlob: string
  reason: string
  message: string
}

// ---------------------------------------------------------------------------
// Check result types
// ---------------------------------------------------------------------------

export interface PhantomRef {
  file: string
  line: number
  reference: string
  category: string
  name: string
}

export interface PhantomSkillRef {
  file: string
  line: number
  reference: string
  name: string
}

export interface BrokenSubfileRef {
  file: string
  line: number
  reference: string
  resolvedPath: string
}

export interface BannedPatternHit {
  file: string
  line: number
  pattern: BannedPattern
  lineContent: string
}

export interface ExemptHit {
  file: string
  line: number
  pattern: BannedPattern
  reason: string
}

export interface FrontmatterViolation {
  file: string
  rule:
    | 'banned-field'
    | 'unknown-field'
    | 'missing-required-field'
    | 'empty-required-field'
    | 'malformed-frontmatter'
    | 'missing-frontmatter'
    | 'parse-safety'
  field?: string
  message: string
  remediation: string
}

export interface AgentColorViolation {
  file: string
  value: string
  message: string
}

export interface AgentModelViolation {
  file: string
  message: string
}

export interface AgentModeViolation {
  file: string
  message: string
}

export interface AgentStemViolation {
  stem: string
  files: string[]
  message: string
}

export interface DispatchIdentifierViolationBase {
  file: string
  line: number
  identifier: string
  lineContent: string
  message: string
}

export interface UnresolvableSubagentTypeViolation
  extends DispatchIdentifierViolationBase {
  kind: 'unresolvable-subagent-type'
}

export interface NearMissAgentIdentifierViolation
  extends DispatchIdentifierViolationBase {
  kind: 'near-miss-agent-identifier'
  matchedStem: string
}

export type DispatchIdentifierViolation =
  | UnresolvableSubagentTypeViolation
  | NearMissAgentIdentifierViolation

export interface AgentTemperatureViolation {
  file: string
  message: string
}

export interface ArgumentHintViolation {
  file: string
  message: string
}

export interface MigratedSkillIdentifierViolation {
  file: string
  line: number
  identifier: MigratedSkillIdentifier
  lineContent: string
  message: string
}

type MigratedSkillIdentifier =
  | 'task('
  | 'subagent_type'
  | 'todowrite'
  | 'TodoWrite'
  | 'request_user_input'
  | 'ask_user'
  | 'AskUserQuestion'
  | 'update_plan'
  | 'question'

export interface RemovedNamesOverlapViolation {
  kind: 'skill' | 'agent'
  name: string
  message: string
}

export interface HookParityViolation {
  file: string
  claimedHooks: string[]
  actualHooks: string[]
  missingHooks: string[]
  unregisteredHooks: string[]
  message: string
}

export interface CodemapCompletenessViolation {
  kind: 'missing-from-codemap' | 'missing-on-disk'
  module: string
  message: string
}

export interface CheckResult {
  rootDir: string
  categories: string[]
  allowlistWarnings: AllowlistWarning[]
  phantomRefs: PhantomRef[]
  phantomSkillRefs: PhantomSkillRef[]
  brokenSubfileRefs: BrokenSubfileRef[]
  bannedPatterns: BannedPatternHit[]
  frontmatterViolations: FrontmatterViolation[]
  parseSafetyViolations: FrontmatterViolation[]
  agentModelViolations: AgentModelViolation[]
  agentModeViolations: AgentModeViolation[]
  agentColorViolations: AgentColorViolation[]
  agentStemViolations: AgentStemViolation[]
  dispatchIdentifierViolations: DispatchIdentifierViolation[]
  agentTemperatureViolations: AgentTemperatureViolation[]
  argumentHintViolations: ArgumentHintViolation[]
  migratedSkillIdentifierViolations: MigratedSkillIdentifierViolation[]
  removedNamesOverlapViolations: RemovedNamesOverlapViolation[]
  hookParityViolations: HookParityViolation[]
  codemapCompletenessViolations: CodemapCompletenessViolation[]
  exemptHits: ExemptHit[]
  scanStats: {
    markdownFiles: number
    typescriptFiles: number
    solutionMarkdownFiles: number
    rootDocuments: number
  }
}

const ALLOWED_SKILL_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(
  SKILL_FRONTMATTER_FIELDS,
)

const BANNED_SKILL_FRONTMATTER_FIELDS = new Set(['preconditions'])
const FRONTMATTER_REMEDIATION =
  'Update frontmatter to match systematic:writing-skills (Systematic Bundled Skills section).'

// ---------------------------------------------------------------------------
// Allowlist loader
// ---------------------------------------------------------------------------

const ALLOWLIST_RELATIVE_PATH = 'scripts/.drift-allowlist.json'
const MIN_REASON_LENGTH = 20

/**
 * Throw-on-invalid, warn-on-suspicious allowlist loader.
 *
 * - Missing file: treated as an empty allowlist (gate still runs, no exemptions apply).
 * - Malformed JSON: throws with the parse error location.
 * - Entry validation: pathGlob non-empty string; patterns non-empty array of
 *   known banned patterns; reason length >= MIN_REASON_LENGTH; no unsupported
 *   glob chars (only `<path>/**` or exact match).
 * - Warnings (non-fatal, returned in the result): zero-match pathGlobs (likely
 *   stale) and broad `**` pathGlobs without a specific subdirectory prefix.
 */
export function loadAllowlist(
  rootDir: string,
  scannedFiles: readonly string[] = [],
): { allowlist: AllowlistFile; warnings: AllowlistWarning[] } {
  const allowlistPath = path.join(rootDir, ALLOWLIST_RELATIVE_PATH)

  if (!fs.existsSync(allowlistPath)) {
    return { allowlist: { exemptions: [] }, warnings: [] }
  }

  const raw = readAllowlistFile(allowlistPath)
  const parsed = parseAllowlistJson(raw)
  const exemptions = parsed.exemptions.map((entry, i) =>
    validateAllowlistEntry(entry, i),
  )
  const warnings = buildAllowlistWarnings(exemptions, scannedFiles)
  return { allowlist: { exemptions }, warnings }
}

function readAllowlistFile(allowlistPath: string): string {
  try {
    return fs.readFileSync(allowlistPath, 'utf8')
  } catch (err) {
    throw new Error(
      `Failed to read allowlist at ${ALLOWLIST_RELATIVE_PATH}: ${(err as Error).message}`,
    )
  }
}

function parseAllowlistJson(raw: string): { exemptions: unknown[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${ALLOWLIST_RELATIVE_PATH}: ${(err as Error).message}`,
    )
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.exemptions)) {
    throw new Error(
      `${ALLOWLIST_RELATIVE_PATH}: expected { exemptions: [...] } at the top level`,
    )
  }
  return { exemptions: parsed.exemptions }
}

function validateAllowlistEntry(entry: unknown, index: number): AllowlistEntry {
  const where = `${ALLOWLIST_RELATIVE_PATH} exemptions[${index}]`

  if (!isRecord(entry)) {
    throw new Error(`${where}: expected an object, got ${typeof entry}`)
  }

  const { pathGlob, patterns, reason } = entry
  assertValidPathGlob(pathGlob, where)
  assertValidPatterns(patterns, where)
  assertValidReason(reason, where)

  return {
    pathGlob: pathGlob as string,
    patterns: patterns as BannedPattern[],
    reason: reason as string,
  }
}

function assertValidPathGlob(pathGlob: unknown, where: string): void {
  if (typeof pathGlob !== 'string' || pathGlob.length === 0) {
    throw new Error(`${where}: pathGlob must be a non-empty string`)
  }
  if (!isSupportedPathGlob(pathGlob)) {
    throw new Error(
      `${where}: pathGlob ${JSON.stringify(pathGlob)} uses unsupported glob syntax. ` +
        `Only "<path>/**" prefix or exact match is supported.`,
    )
  }
}

function assertValidPatterns(patterns: unknown, where: string): void {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error(`${where}: patterns must be a non-empty array`)
  }
  for (const pat of patterns) {
    if (!isBannedPattern(pat)) {
      throw new Error(
        `${where}: pattern ${JSON.stringify(pat)} is not a known banned pattern. ` +
          `Known: ${BANNED_PATTERNS.join(', ')}`,
      )
    }
  }
}

function assertValidReason(reason: unknown, where: string): void {
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
    throw new Error(
      `${where}: reason must be a string of at least ${MIN_REASON_LENGTH} characters`,
    )
  }
}

/**
 * Allowlist pathGlob syntax: either `<path>/**` (prefix match) or an exact path.
 * Reject anything containing other glob wildcards (`?`, `[...]`, bare `*`).
 */
function isSupportedPathGlob(pathGlob: string): boolean {
  if (pathGlob.endsWith('/**')) {
    const prefix = pathGlob.slice(0, -3)
    return prefix.length > 0 && !containsUnsupportedGlobChars(prefix)
  }
  return !containsUnsupportedGlobChars(pathGlob)
}

function containsUnsupportedGlobChars(value: string): boolean {
  return /[*?[\]]/.test(value)
}

/**
 * True when `filePath` (repo-relative) matches `pathGlob`.
 *
 * - `<path>/**` matches any file under `<path>/`.
 * - exact path matches byte-for-byte.
 */
export function matchesPathGlob(filePath: string, pathGlob: string): boolean {
  if (pathGlob.endsWith('/**')) {
    const prefix = pathGlob.slice(0, -3)
    return filePath.startsWith(`${prefix}/`)
  }
  return filePath === pathGlob
}

function buildAllowlistWarnings(
  exemptions: readonly AllowlistEntry[],
  scannedFiles: readonly string[],
): AllowlistWarning[] {
  const warnings: AllowlistWarning[] = []

  for (const entry of exemptions) {
    if (isBroadPathGlob(entry.pathGlob)) {
      warnings.push({
        kind: 'broad-pathglob',
        pathGlob: entry.pathGlob,
        reason: entry.reason,
        message:
          `Broad pathGlob ${JSON.stringify(entry.pathGlob)} uses '**' without a ` +
          `specific subdirectory prefix. This exempts a large swath of the catalog; ` +
          `prefer narrower globs when possible.`,
      })
    }

    if (scannedFiles.length > 0) {
      const matched = scannedFiles.some((f) =>
        matchesPathGlob(f, entry.pathGlob),
      )
      if (!matched) {
        warnings.push({
          kind: 'zero-match',
          pathGlob: entry.pathGlob,
          reason: entry.reason,
          message:
            `pathGlob ${JSON.stringify(entry.pathGlob)} matched zero scanned files. ` +
            `The exemption is likely stale (file renamed or deleted) and can be removed.`,
        })
      }
    }
  }

  return warnings
}

function isBroadPathGlob(pathGlob: string): boolean {
  if (!pathGlob.endsWith('/**')) return false
  const prefix = pathGlob.slice(0, -3)
  // A prefix needs ≥ 2 non-empty path segments to be "specific".
  // `skills/foo/**` (2 segments) is specific; `skills/**` (1 segment) is broad
  // because it exempts every skill with a single entry.
  return prefix.split('/').filter((s) => s.length > 0).length < 2
}

// ---------------------------------------------------------------------------
// Category discovery
// ---------------------------------------------------------------------------

/**
 * Read `agents/` subdirectories at runtime. Any directory whose name does not
 * start with `.` is treated as a valid category.
 */
export function discoverCategories(rootDir: string): string[] {
  const agentsDir = path.join(rootDir, 'agents')
  if (!fs.existsSync(agentsDir)) return []

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

// ---------------------------------------------------------------------------
// Scan-target collection
// ---------------------------------------------------------------------------

export interface ScanTargets {
  markdown: string[] // repo-relative paths under skills/ and agents/
  typescript: string[] // repo-relative paths under src/ (excluding markdown)
  solutionMarkdown: string[] // repo-relative paths under docs/solutions/ (parse-safety only)
  rootDocuments: string[] // named contributor-facing root docs (hook parity only)
}

export const HOOK_PARITY_DOCUMENTS = [
  'ARCHITECTURE.md',
  'STRUCTURE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
] as const

// Keep exemptions explicit. The current named documents all assert the
// registered set; a legitimate hook discussion without that assertion is
// simply ignored by the claim extractor and needs no exemption entry.
export const HOOK_PARITY_EXEMPTIONS: ReadonlySet<string> = new Set()

export const CODEMAP_DOCUMENT = 'ARCHITECTURE.md'
export const CODEMAP_EXCLUSION_HEADING = '## Codemap exclusions'

const HOOK_ASSERTION_REGEX =
  /\b(?:registers?|exposes?)\b(?:[^\n]*\n){0,2}?\s*(?:these|every|all|one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?:\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+))?\s+(?:OpenCode\s+)?hooks?\b/i
const INLINE_HOOK_REGEX = /`([^`\n]+)`/g

/**
 * Collect the files the gate scans. Paths are repo-relative for consistent
 * allowlist matching.
 *
 * - `markdown`: skills/ and agents/ markdown — full invariant suite.
 * - `typescript`: src/ TypeScript — banned-pattern scan.
 * - `solutionMarkdown`: docs/solutions/ markdown — parse-safety check ONLY.
 *   Deliberately NOT merged into `markdown` to keep banned-pattern enforcement
 *   scoped to skills+agents+src; historical solution docs may legitimately
 *   reference CC/CEP terms.
 */
export function collectScanTargets(rootDir: string): ScanTargets {
  const markdown: string[] = []
  for (const area of ['skills', 'agents']) {
    const areaDir = path.join(rootDir, area)
    if (!fs.existsSync(areaDir)) continue

    const entries = walkDir(areaDir, {
      maxDepth: 10,
      filter: (e) => !e.isDirectory && e.name.endsWith('.md'),
    })
    for (const e of entries) {
      markdown.push(path.relative(rootDir, e.path))
    }
  }

  const typescript: string[] = []
  const srcDir = path.join(rootDir, 'src')
  if (fs.existsSync(srcDir)) {
    const entries = walkDir(srcDir, {
      maxDepth: 10,
      filter: (e) => !e.isDirectory && e.name.endsWith('.ts'),
    })
    for (const e of entries) {
      typescript.push(path.relative(rootDir, e.path))
    }
  }

  const solutionMarkdown: string[] = []
  const solutionsDir = path.join(rootDir, 'docs', 'solutions')
  if (fs.existsSync(solutionsDir)) {
    const entries = walkDir(solutionsDir, {
      maxDepth: 10,
      filter: (e) => !e.isDirectory && e.name.endsWith('.md'),
    })
    for (const e of entries) {
      solutionMarkdown.push(path.relative(rootDir, e.path))
    }
  }

  const rootDocuments = HOOK_PARITY_DOCUMENTS.filter((relPath) =>
    fs.existsSync(path.join(rootDir, relPath)),
  )

  markdown.sort()
  typescript.sort()
  solutionMarkdown.sort()
  return {
    markdown,
    typescript,
    solutionMarkdown,
    rootDocuments: [...rootDocuments].sort(),
  }
}

// ---------------------------------------------------------------------------
// Reference-integrity check
// ---------------------------------------------------------------------------

/**
 * Match `systematic:<category>:<name>` references. The category list is
 * built at runtime from `discoverCategories`, so the final regex is assembled
 * per-invocation rather than hardcoded.
 */
function buildReferenceRegex(categories: readonly string[]): RegExp | null {
  if (categories.length === 0) return null
  const escaped = categories.map(escapeRegex).join('|')
  // Category + name both kebab-case-ish: [a-z0-9-]+
  return new RegExp(`systematic:(${escaped}):([a-z0-9-]+)`, 'g')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function checkReferenceIntegrity(
  rootDir: string,
  markdownFiles: readonly string[],
  categories: readonly string[],
): PhantomRef[] {
  const regex = buildReferenceRegex(categories)
  if (!regex) return []

  const phantoms: PhantomRef[] = []

  for (const relPath of markdownFiles) {
    const absPath = path.join(rootDir, relPath)
    const content = readFileSafe(absPath)
    if (content === null) continue

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      for (const match of line.matchAll(regex)) {
        const [ref, category, name] = match as unknown as [
          string,
          string,
          string,
        ]
        const targetPath = path.join(rootDir, 'agents', category, `${name}.md`)
        if (!fs.existsSync(targetPath)) {
          phantoms.push({
            file: relPath,
            line: i + 1,
            reference: ref,
            category,
            name,
          })
        }
      }
    }
  }

  return phantoms
}

/**
 * Match `ce:<name>` skill references (e.g. `ce:brainstorm`, `` `ce:work` ``).
 * Word-boundary + kebab-case name only, to avoid flagging incidental "ce:"
 * prose that isn't a skill reference.
 */
const SKILL_REF_REGEX = /\bce:([a-z0-9-]+)\b/g

export function checkSkillReferenceIntegrity(
  rootDir: string,
  markdownFiles: readonly string[],
): PhantomSkillRef[] {
  const phantoms: PhantomSkillRef[] = []

  for (const relPath of markdownFiles) {
    const absPath = path.join(rootDir, relPath)
    const content = readFileSafe(absPath)
    if (content === null) continue

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      for (const match of line.matchAll(SKILL_REF_REGEX)) {
        const [ref, name] = match as unknown as [string, string]
        const targetPath = path.join(rootDir, 'skills', `ce-${name}`)
        if (!fs.existsSync(targetPath)) {
          phantoms.push({
            file: relPath,
            line: i + 1,
            reference: ref,
            name,
          })
        }
      }
    }
  }

  return phantoms
}

// ---------------------------------------------------------------------------
// Sub-file reference-integrity check
// ---------------------------------------------------------------------------

/**
 * Subdirectories whose paths, when mentioned inside a SKILL.md, denote
 * sub-files of that skill. Adding a new convention here also requires updating
 * the regex below.
 */
export const SUBFILE_DIRECTORY_NAMES = [
  'references',
  'scripts',
  'templates',
  'assets',
] as const

/**
 * Match relative paths under a skill's sub-directory:
 *
 *   `references/foo.md`, `scripts/foo.sh`, `templates/foo.md`,
 *   `assets/foo.md`, `./references/foo.md`, etc.
 *
 * The match boundary on the left side requires start-of-line, whitespace,
 * an opening parenthesis, or a backtick. This avoids false positives like
 * `hotwire-native/references/foo.md` (different skill, prefixed path) and
 * `.github/workflows/foo.yml` (Github Actions workflow, not a skill sub-file).
 *
 * The path body is restricted to characters typical for filenames + slashes,
 * and must end in a known file extension. The regex deliberately uses a
 * conservative character set so a stray space or quote in the surrounding
 * prose terminates the match cleanly.
 */
const SUBFILE_PATH_REGEX = new RegExp(
  `(?:^|[\\s\\(\`])(\\.\\/)?` +
    `((?:${SUBFILE_DIRECTORY_NAMES.join('|')})\\/[\\w./-]+\\.(?:md|json|ya?ml|sh|ts|js|mjs|txt|py))`,
  'g',
)

/**
 * Verify every sub-file path mentioned in a `skills/<name>/SKILL.md` resolves
 * to an actual file in that skill directory.
 *
 * Only `skills/*\/SKILL.md` files are scanned; nested reference files (e.g.,
 * `skills/foo/references/bar.md`) are skipped because their internal paths are
 * either documentation examples or relative to a different working directory.
 */
export function checkSubfileReferences(
  rootDir: string,
  markdownFiles: readonly string[],
): BrokenSubfileRef[] {
  const broken: BrokenSubfileRef[] = []

  for (const relPath of markdownFiles) {
    if (!isSkillEntryFile(relPath)) continue
    const absPath = path.join(rootDir, relPath)
    const content = readFileSafe(absPath)
    if (content === null) continue
    scanSkillForBrokenSubfiles(rootDir, relPath, absPath, content, broken)
  }

  return broken
}

function scanSkillForBrokenSubfiles(
  rootDir: string,
  relPath: string,
  absPath: string,
  content: string,
  broken: BrokenSubfileRef[],
): void {
  const skillDir = path.dirname(absPath)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const match of line.matchAll(SUBFILE_PATH_REGEX)) {
      const reference = (match[2] ?? '').trim()
      if (reference.length === 0) continue
      const resolvedAbs = path.join(skillDir, reference)
      if (fs.existsSync(resolvedAbs)) continue
      broken.push({
        file: relPath,
        line: i + 1,
        reference,
        resolvedPath: path.relative(rootDir, resolvedAbs),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter checks
// ---------------------------------------------------------------------------

export function checkFrontmatter(
  rootDir: string,
  markdownFiles: readonly string[],
): FrontmatterViolation[] {
  const violations: FrontmatterViolation[] = []

  for (const relPath of markdownFiles) {
    if (!isSkillEntryFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    scanSkillFrontmatter(relPath, content, violations)
  }

  return violations
}

function scanSkillFrontmatter(
  relPath: string,
  content: string,
  violations: FrontmatterViolation[],
): void {
  const parsed = parseFrontmatter(content)

  if (parsed.parseError) {
    violations.push({
      file: relPath,
      rule: 'malformed-frontmatter',
      message: 'Skill frontmatter is malformed YAML.',
      remediation: FRONTMATTER_REMEDIATION,
    })
    return
  }

  if (!parsed.hadFrontmatter) {
    violations.push({
      file: relPath,
      rule: 'missing-frontmatter',
      message: 'Skill is missing YAML frontmatter.',
      remediation: FRONTMATTER_REMEDIATION,
    })
    return
  }

  checkRequiredSkillField(relPath, parsed.data, 'name', violations)
  checkRequiredSkillField(relPath, parsed.data, 'description', violations)
  checkSkillFrontmatterFields(relPath, parsed.data, violations)
}

function checkRequiredSkillField(
  relPath: string,
  data: Record<string, unknown>,
  field: 'name' | 'description',
  violations: FrontmatterViolation[],
): void {
  if (!Object.hasOwn(data, field) || data[field] === null) {
    violations.push({
      file: relPath,
      rule: 'missing-required-field',
      field,
      message: `Skill frontmatter is missing required ${field} field.`,
      remediation: FRONTMATTER_REMEDIATION,
    })
    return
  }

  if (typeof data[field] === 'string' && data[field].trim() === '') {
    violations.push({
      file: relPath,
      rule: 'empty-required-field',
      field,
      message: `Skill frontmatter ${field} field must not be empty.`,
      remediation: FRONTMATTER_REMEDIATION,
    })
  }
}

function checkSkillFrontmatterFields(
  relPath: string,
  data: Record<string, unknown>,
  violations: FrontmatterViolation[],
): void {
  for (const field of Object.keys(data)) {
    if (BANNED_SKILL_FRONTMATTER_FIELDS.has(field)) {
      violations.push({
        file: relPath,
        rule: 'banned-field',
        field,
        message: `Skill frontmatter field ${field} is banned.`,
        remediation: FRONTMATTER_REMEDIATION,
      })
      continue
    }

    if (!ALLOWED_SKILL_FRONTMATTER_FIELDS.has(field)) {
      violations.push({
        file: relPath,
        rule: 'unknown-field',
        field,
        message: `Skill frontmatter field ${field} is not recognized by the runtime loader.`,
        remediation: FRONTMATTER_REMEDIATION,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parse-safety check
// ---------------------------------------------------------------------------

/**
 * Ban unquoted inline comments in docs/solutions/ frontmatter.
 *
 * Scope: flat top-level `key: value` lines only. Nested/indented mapping
 * values (lines that start with whitespace) are intentionally not scanned —
 * see `extractFlatKeyValue`.
 *
 * A top-level flat `key: value` line is flagged when ALL of:
 * - It is a flat key-value line (not a full-line comment, list item, indented
 *   continuation, or block-scalar indicator).
 * - The value is NOT wrapped in matching quotes (quoted values are safe; a `#`
 *   inside quotes is literal).
 * - The unquoted value contains a comment trigger: whitespace-before-`#`
 *   (`/\s#/`) OR the value's first non-space char is `#` (`/^\s*#/`).
 *
 * The decision is purely lexical — no parse-diff corroboration. Policy: inline
 * YAML comments in solution-doc frontmatter are banned regardless of whether
 * the YAML parser happens to preserve the value, because the distinction is
 * undecidable from the raw text alone.
 *
 * Emits a `FrontmatterViolation` with `rule: 'parse-safety'`.
 */
export function checkFrontmatterParseSafety(
  rootDir: string,
  markdownFiles: readonly string[],
): FrontmatterViolation[] {
  const violations: FrontmatterViolation[] = []

  for (const relPath of markdownFiles) {
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    scanFrontmatterParseSafety(relPath, content, violations)
  }

  return violations
}

function scanFrontmatterParseSafety(
  relPath: string,
  content: string,
  violations: FrontmatterViolation[],
): void {
  const rawBlock = extractFrontmatterBlock(content)
  if (rawBlock === null) return

  const lines = rawBlock.split('\n')
  for (const line of lines) {
    const violation = checkParseSafetyLine(relPath, line)
    if (violation) violations.push(violation)
  }
}

/**
 * Inspect a single frontmatter line for an unquoted inline comment.
 * Returns a violation if the line is a flat `key: value` with an unquoted
 * value containing a comment trigger, or null if the line is safe or out of
 * scope.
 */
function checkParseSafetyLine(
  relPath: string,
  line: string,
): FrontmatterViolation | null {
  const kv = extractFlatKeyValue(line)
  if (!kv) return null

  const { key, rawValue } = kv
  if (isQuotedValue(rawValue)) return null
  if (!isCommentCandidate(rawValue)) return null

  return {
    file: relPath,
    rule: 'parse-safety',
    field: key,
    message:
      `Frontmatter field \`${key}\` contains an unquoted inline comment (whitespace before \`#\` or value starting with \`#\`). ` +
      `Inline YAML comments in solution-doc frontmatter are silently stripped and risk data loss. ` +
      `Raw value: ${JSON.stringify(rawValue)}`,
    remediation:
      'Quote the value or remove the inline comment — inline YAML comments in solution-doc frontmatter are silently stripped and risk data loss.',
  }
}

/**
 * Extract the key and raw value from a flat `key: value` frontmatter line.
 * Returns null for lines that are not flat key-value pairs (comments, list
 * items, indented lines, block-scalar indicators).
 *
 * Scope boundary: indented lines (lines starting with whitespace) are skipped
 * unconditionally. A `#` inside a nested mapping value such as
 * `  note: cache miss # under load` is therefore out of scope by design —
 * only flat top-level key-value lines are inspected.
 */
function extractFlatKeyValue(
  line: string,
): { key: string; rawValue: string } | null {
  if (/^\s*#/.test(line)) return null
  if (/^\s*- /.test(line)) return null
  if (/^\s/.test(line)) return null
  if (/^([^:]+):\s*[|>]/.test(line)) return null

  const kvMatch = line.match(/^([^:]+):\s(.*)$/)
  if (!kvMatch) return null

  return { key: (kvMatch[1] ?? '').trim(), rawValue: kvMatch[2] ?? '' }
}

/**
 * True when `rawValue` is a candidate for comment-truncation: it contains
 * whitespace-before-hash (`\s#`) or starts with `#` (both cause YAML to treat
 * the text as a comment, silently dropping content).
 */
function isCommentCandidate(rawValue: string): boolean {
  return /\s#/.test(rawValue) || /^\s*#/.test(rawValue)
}

/**
 * True when `value` is wrapped in matching double or single quotes.
 * A `#` inside a quoted value is literal, not a comment trigger.
 */
function isQuotedValue(value: string): boolean {
  const trimmed = value.trim()
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  )
}

export function checkAgentColors(
  rootDir: string,
  markdownFiles: readonly string[],
): AgentColorViolation[] {
  const violations: AgentColorViolation[] = []

  for (const relPath of markdownFiles) {
    if (!isAgentFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    const parsed = parseFrontmatter(content)
    if (!isRecord(parsed.data)) continue
    if (!Object.hasOwn(parsed.data, 'color')) continue
    const value = parsed.data.color
    if (typeof value !== 'string' || isValidAgentColor(value)) continue
    violations.push({
      file: relPath,
      value,
      message: `Agent color \`${value}\` is rejected by OpenCode's \`/config\` response schema. Allowed values: hex \`#RRGGBB\` or one of ${OPENCODE_AGENT_COLOR_TOKENS.join(', ')}. Crashes TUI launch with HttpApiSchemaError.`,
    })
  }

  return violations
}

export function checkAgentModel(
  rootDir: string,
  markdownFiles: readonly string[],
): AgentModelViolation[] {
  const violations: AgentModelViolation[] = []

  for (const relPath of markdownFiles) {
    if (!isAgentFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    const parsed = parseFrontmatter(content)
    if (!isRecord(parsed.data)) continue
    if (Object.hasOwn(parsed.data, 'model')) {
      violations.push({
        file: relPath,
        message:
          "Bundled agents must omit the `model` field. OpenCode subagents inherit the invoking primary agent's model when `model` is unset (per https://opencode.ai/docs/agents/). The literal `model: inherit` was undocumented and produced ProviderModelNotFoundError on OpenCode older than ~v1.13.x (pre sst/opencode#17888).",
      })
    }
  }

  return violations
}

export function checkAgentMode(
  rootDir: string,
  markdownFiles: readonly string[],
): AgentModeViolation[] {
  const violations: AgentModeViolation[] = []

  for (const relPath of markdownFiles) {
    if (!isAgentFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    const parsed = parseFrontmatter(content)
    if (!isRecord(parsed.data) || parsed.data.mode !== 'subagent') {
      violations.push({
        file: relPath,
        message:
          "Bundled agents must declare `mode: subagent` explicitly. The runtime applies no default; without an explicit `mode`, agents would fall back to OpenCode's native default (`all`), making internal agents primary-visible.",
      })
    }
  }

  return violations
}

export function checkAgentTemperature(
  rootDir: string,
  markdownFiles: readonly string[],
): AgentTemperatureViolation[] {
  const violations: AgentTemperatureViolation[] = []

  for (const relPath of markdownFiles) {
    if (!isAgentFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    const parsed = parseFrontmatter(content)
    if (
      !isRecord(parsed.data) ||
      !Object.hasOwn(parsed.data, 'temperature') ||
      typeof parsed.data.temperature !== 'number' ||
      !Number.isFinite(parsed.data.temperature)
    ) {
      violations.push({
        file: relPath,
        message:
          'Bundled agents must declare an explicit `temperature:` in frontmatter. ' +
          'The runtime has no fallback for a missing value; ' +
          'without an explicit `temperature:`, the agent would run with no tuned value set.',
      })
    }
  }

  return violations
}

export function checkAgentStemUniqueness(
  rootDir: string,
  markdownFiles: readonly string[],
): AgentStemViolation[] {
  const filesByStem = new Map<string, string[]>()

  for (const relPath of markdownFiles) {
    if (!isAgentFile(relPath)) continue
    if (!fs.existsSync(path.join(rootDir, relPath))) continue

    const stem = path.basename(relPath, '.md')
    const files = filesByStem.get(stem) ?? []
    files.push(relPath)
    filesByStem.set(stem, files)
  }

  return [...filesByStem.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([stem, files]) => ({
      stem,
      files: [...files].sort(),
      message:
        `Duplicate bundled agent stem \`${stem}\` found in ${files.length} files. ` +
        'V1 emits stem-only OpenCode agent keys, so bundled agent filenames must be globally unique across categories.',
    }))
    .sort((a, b) => a.stem.localeCompare(b.stem))
}

// The unquoted branch must stop at backticks and quotes as well as at whitespace
// and delimiters. Dispatch examples are frequently written inside an inline-
// code span (`` `subagent_type: explorer` ``) or prose quotes
// (`` "subagent_type: explorer" ``), and swallowing the closing delimiter
// yields a value that can never match a bundled stem — a false positive on
// correct content, which a fail-closed gate cannot afford.
const SUBAGENT_TYPE_ASSIGNMENT_REGEX =
  /(?:\bsubagent_type\b|"subagent_type"|'subagent_type')\s*:\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,})`"']+))/g
const INLINE_CODE_SPAN_REGEX = /`([^`\n]+)`/g
const NEAR_MISS_AGENT_IDENTIFIER_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/
const INLINE_CODE_TOKEN_SPLIT_REGEX = /[^a-z0-9/.:-]+/
const FENCE_START_REGEX = /^\s*(`{3,}|~{3,})/

interface FenceMarker {
  character: string
  length: number
}

function collectBundledAgentStems(
  rootDir: string,
  markdownFiles: readonly string[],
): Set<string> {
  const stems = new Set<string>()

  for (const relPath of markdownFiles) {
    if (!isAgentFile(relPath)) continue
    if (!fs.existsSync(path.join(rootDir, relPath))) continue
    stems.add(path.basename(relPath, '.md'))
  }

  return stems
}

function scanSubagentTypeAssignments(
  relPath: string,
  line: string,
  lineNumber: number,
  bundledAgentStems: ReadonlySet<string>,
): DispatchIdentifierViolation[] {
  const violations: DispatchIdentifierViolation[] = []

  for (const match of line.matchAll(SUBAGENT_TYPE_ASSIGNMENT_REGEX)) {
    const identifier = match[1] ?? match[2] ?? match[3] ?? ''
    if (bundledAgentStems.has(identifier)) continue

    violations.push({
      kind: 'unresolvable-subagent-type',
      file: relPath,
      line: lineNumber,
      identifier,
      lineContent: line,
      message:
        `The subagent_type value \`${identifier}\` is unresolvable. Bundled ` +
        'content must name an agent this package ships: use a filename stem ' +
        'from agents/**. A host may provide additional agents at runtime, but ' +
        'they must not appear in bundled examples.',
    })
  }

  return violations
}

/**
 * Bundled skill directory names, excluded from near-miss detection.
 *
 * Skill directories are kebab-case like agent stems, so a skill named `ce-plan`
 * would read as a near miss of a bundled agent named `plan`. No such agent
 * exists today, but relying on that coincidence would mean a single future
 * naming choice fails every `ce-plan` reference across the bundle at once.
 * Excluding real skill names removes the coupling instead of documenting it.
 */
function collectBundledSkillNames(rootDir: string): Set<string> {
  const names = new Set<string>()
  const skillsDir = path.join(rootDir, 'skills')
  if (!fs.existsSync(skillsDir)) return names

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) names.add(entry.name)
  }

  return names
}

function findNearMissAgentStem(
  identifier: string,
  bundledAgentStems: ReadonlySet<string>,
  bundledSkillNames: ReadonlySet<string>,
): string | null {
  if (!NEAR_MISS_AGENT_IDENTIFIER_REGEX.test(identifier)) return null
  if (bundledAgentStems.has(identifier)) return null
  if (bundledSkillNames.has(identifier)) return null

  return (
    [...bundledAgentStems]
      .filter((stem) => identifier.endsWith(`-${stem}`))
      .sort((a, b) => b.length - a.length)[0] ?? null
  )
}

function scanNearMissAgentIdentifiers(
  relPath: string,
  line: string,
  lineNumber: number,
  bundledAgentStems: ReadonlySet<string>,
  bundledSkillNames: ReadonlySet<string>,
): DispatchIdentifierViolation[] {
  const violations: DispatchIdentifierViolation[] = []

  for (const spanMatch of line.matchAll(INLINE_CODE_SPAN_REGEX)) {
    const span = spanMatch[1] ?? ''

    for (const identifier of span.split(INLINE_CODE_TOKEN_SPLIT_REGEX)) {
      // Paths and canonical references are intentionally not dispatch
      // identifiers, even when one of their components resembles a stem.
      if (identifier.length === 0 || /[/.:]/.test(identifier)) continue
      const matchedStem = findNearMissAgentStem(
        identifier,
        bundledAgentStems,
        bundledSkillNames,
      )
      if (!matchedStem) continue

      violations.push({
        kind: 'near-miss-agent-identifier',
        file: relPath,
        line: lineNumber,
        identifier,
        lineContent: line,
        matchedStem,
        message:
          `Inline-code identifier \`${identifier}\` ends with bundled ` +
          `agent stem \`${matchedStem}\` but is not itself a resolvable ` +
          `agent dispatch identifier. Did you mean \`${matchedStem}\`?`,
      })
    }
  }

  return violations
}

function updateFenceMarker(
  line: string,
  currentMarker: FenceMarker | null,
): { marker: FenceMarker | null; isFence: boolean } {
  const fenceMatch = line.match(FENCE_START_REGEX)
  if (!fenceMatch) return { marker: currentMarker, isFence: false }

  const markerRun = fenceMatch[1] ?? ''
  const character = markerRun[0] ?? null
  if (character === null) return { marker: currentMarker, isFence: true }
  const marker: FenceMarker = { character, length: markerRun.length }
  if (currentMarker === null) return { marker, isFence: true }
  if (
    marker.character === currentMarker.character &&
    marker.length >= currentMarker.length
  ) {
    return { marker: null, isFence: true }
  }
  return { marker: currentMarker, isFence: true }
}

export function checkDispatchIdentifiers(
  rootDir: string,
  markdownFiles: readonly string[],
): DispatchIdentifierViolation[] {
  const bundledAgentStems = collectBundledAgentStems(rootDir, markdownFiles)
  const bundledSkillNames = collectBundledSkillNames(rootDir)
  const violations: DispatchIdentifierViolation[] = []

  for (const relPath of markdownFiles) {
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue

    const lines = content.split('\n')
    let fenceMarker: FenceMarker | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''

      violations.push(
        ...scanSubagentTypeAssignments(relPath, line, i + 1, bundledAgentStems),
      )

      const fence = updateFenceMarker(line, fenceMarker)
      fenceMarker = fence.marker
      if (fence.isFence || fenceMarker !== null) continue

      violations.push(
        ...scanNearMissAgentIdentifiers(
          relPath,
          line,
          i + 1,
          bundledAgentStems,
          bundledSkillNames,
        ),
      )
    }
  }

  return violations
}

function extractHookClaim(
  content: string,
  actualHooks: readonly string[],
): string[] | null {
  const contentWithoutAssertions = stripMarkdownNonAssertions(content)
  const assertion = contentWithoutAssertions.match(HOOK_ASSERTION_REGEX)
  if (!assertion || assertion.index === undefined) return null

  const assertionSection = extractHookAssertionSection(
    contentWithoutAssertions,
    assertion.index,
  )
  const claimedHooks = extractClaimedHookNames(assertionSection)
  const namesRegisteredBySource = claimedHooks.filter((hook) =>
    actualHooks.includes(hook),
  )

  if (
    /\b(?:every|all)\b[\s\S]{0,30}\bhooks?\b/i.test(assertion[0]) &&
    namesRegisteredBySource.length === 0
  ) {
    return [...actualHooks]
  }

  return claimedHooks
}

function extractHookAssertionSection(content: string, start: number): string {
  const afterAssertion = content.slice(start)
  const nextHeading = afterAssertion.search(/\n#{1,6}\s/)
  return nextHeading >= 0
    ? afterAssertion.slice(0, nextHeading)
    : afterAssertion
}

function extractHookBulletLines(section: string): string[] {
  const bulletLines: string[] = []
  let collectingBullets = false
  for (const line of section.split('\n')) {
    if (/^\s*[-*]\s+/.test(line)) {
      collectingBullets = true
      bulletLines.push(line)
      continue
    }
    if (collectingBullets && line.trim() === '') break
  }
  return bulletLines
}

function extractClaimedHookNames(section: string): string[] {
  const bulletLines = extractHookBulletLines(section)
  const claimed = new Set<string>()
  if (bulletLines.length > 0) {
    for (const line of bulletLines) {
      const inline = line.match(/`([^`\n]+)`/)
      const hook =
        inline?.[1]?.trim() ??
        line.match(/^\s*[-*]\s+(?:\*\*)?([A-Za-z][\w.-]*)/)?.[1]?.trim()
      if (hook) claimed.add(hook)
    }
  } else {
    for (const match of section.matchAll(INLINE_HOOK_REGEX)) {
      const hook = match[1]?.trim()
      if (hook) claimed.add(hook)
    }
  }

  return [...claimed].sort()
}

function extractRegisteredPluginHooks(rootDir: string): string[] {
  const source = readFileSafe(path.join(rootDir, 'src', 'index.ts'))
  if (source === null) {
    throw new Error('Unable to read plugin entry point at src/index.ts')
  }

  const inventoryMatch = source.match(
    /const\s+REGISTERED_PLUGIN_HOOKS\s*=\s*\[([\s\S]*?)\]\s+as\s+const\b/,
  )
  if (!inventoryMatch) {
    throw new Error(
      'Unable to locate REGISTERED_PLUGIN_HOOKS in src/index.ts while checking hook parity',
    )
  }

  const inventoryBody = inventoryMatch[1] ?? ''
  const hooks = new Set<string>()
  for (const match of inventoryBody.matchAll(/(['"])([^'"\n]+)\1/g)) {
    const hook = match[2]
    if (hook) hooks.add(hook)
  }

  if (hooks.size === 0) {
    throw new Error(
      'Unable to derive plugin hooks from REGISTERED_PLUGIN_HOOKS in src/index.ts',
    )
  }
  return [...hooks].sort()
}

export function checkHookParity(
  rootDir: string,
  documentFiles: readonly string[] = HOOK_PARITY_DOCUMENTS,
  exemptDocuments: ReadonlySet<string> = HOOK_PARITY_EXEMPTIONS,
): HookParityViolation[] {
  const documents = documentFiles.filter(
    (relPath) =>
      !exemptDocuments.has(relPath) &&
      fs.existsSync(path.join(rootDir, relPath)),
  )
  if (documents.length === 0) return []

  const actualHooks = extractRegisteredPluginHooks(rootDir)
  const violations: HookParityViolation[] = []

  for (const file of documents) {
    const content = readFileSafe(path.join(rootDir, file))
    if (content === null) continue

    const claimedHooks = extractHookClaim(content, actualHooks)
    if (claimedHooks === null) continue

    const missingHooks = actualHooks.filter(
      (hook) => !claimedHooks.includes(hook),
    )
    const unregisteredHooks = claimedHooks.filter(
      (hook) => !actualHooks.includes(hook),
    )
    if (missingHooks.length === 0 && unregisteredHooks.length === 0) continue

    const problems = [
      missingHooks.length > 0
        ? `missing registered hooks: ${missingHooks.join(', ')}`
        : '',
      unregisteredHooks.length > 0
        ? `unregistered hooks: ${unregisteredHooks.join(', ')}`
        : '',
    ].filter(Boolean)
    violations.push({
      file,
      claimedHooks,
      actualHooks: [...actualHooks],
      missingHooks,
      unregisteredHooks,
      message:
        `${file} claims hooks [${claimedHooks.join(', ')}], but src/index.ts ` +
        `registers [${actualHooks.join(', ')}]; ${problems.join('; ')}`,
    })
  }

  return violations
}

function extractArchitectureSection(
  content: string,
  heading: string,
): string | null {
  const headingIndex = content.indexOf(heading)
  if (headingIndex < 0) return null

  const sectionStart = headingIndex + heading.length
  const nextHeading = content.slice(sectionStart).search(/^##\s+/m)
  return nextHeading < 0
    ? content.slice(sectionStart)
    : content.slice(sectionStart, sectionStart + nextHeading)
}

function extractCodemapExclusionSection(content: string): string {
  return extractArchitectureSection(content, CODEMAP_EXCLUSION_HEADING) ?? ''
}

function extractCodemapModules(content: string): string[] {
  const codemapSection = extractArchitectureSection(content, '## Codemap')
  if (codemapSection === null) return []

  const exclusionSection = extractCodemapExclusionSection(codemapSection)
  const codemapOnly = codemapSection.replace(exclusionSection, '')
  const modules = new Set<string>()
  const moduleRegex = /`?(src\/lib\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.ts)`?/g
  for (const match of codemapOnly.matchAll(moduleRegex)) {
    const module = match[1]
    if (module) modules.add(module)
  }
  return [...modules].sort()
}

function extractCodemapExclusions(content: string): Set<string> {
  const section = extractCodemapExclusionSection(content)
  const exclusions = new Set<string>()
  const moduleRegex = /`?(src\/lib\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.ts)`?/g
  for (const match of section.matchAll(moduleRegex)) {
    const module = match[1]
    if (module) exclusions.add(module)
  }
  return exclusions
}

function collectLibModules(rootDir: string): string[] {
  const libDir = path.join(rootDir, 'src', 'lib')
  if (!fs.existsSync(libDir)) return []

  return walkDir(libDir, {
    maxDepth: 10,
    filter: (entry) => !entry.isDirectory && entry.name.endsWith('.ts'),
  })
    .map((entry) => path.relative(rootDir, entry.path))
    .sort()
}

export function checkCodemapCompleteness(
  rootDir: string,
  architectureFile = CODEMAP_DOCUMENT,
): CodemapCompletenessViolation[] {
  const architecturePath = path.join(rootDir, architectureFile)
  const content = readFileSafe(architecturePath)
  if (content === null) return []

  const onDisk = collectLibModules(rootDir)
  const codemap = extractCodemapModules(content)
  const exclusions = extractCodemapExclusions(content)
  const codemapSet = new Set(codemap)
  const onDiskSet = new Set(onDisk)
  const violations: CodemapCompletenessViolation[] = []

  for (const module of onDisk) {
    if (exclusions.has(module) || codemapSet.has(module)) continue
    violations.push({
      kind: 'missing-from-codemap',
      module,
      message:
        `${module} exists on disk but is absent from ${architectureFile}'s ` +
        `Codemap. Add it or list it in the visible "Codemap exclusions" section.`,
    })
  }

  for (const module of codemap) {
    if (exclusions.has(module) || onDiskSet.has(module)) continue
    violations.push({
      kind: 'missing-on-disk',
      module,
      message:
        `${architectureFile}'s Codemap names ${module}, but no such module ` +
        'exists on disk. Remove the stale entry.',
    })
  }

  return violations
}

/**
 * Strip fenced code blocks (``` or ~~~) from a markdown body string.
 * Returns the body with all fenced regions replaced by empty strings so that
 * literal patterns inside fences are not matched by subsequent scans.
 */
function stripFencedCodeBlocks(body: string): string {
  // Matches ``` or ~~~ fences (with optional language tag) across multiple lines.
  // Anchored at line start, so fences indented inside list items or blockquotes
  // are not stripped. No bundled skill nests a fenced `$ARGUMENTS` that way; if one
  // ever does, the real-tree integration test will surface the false positive.
  return body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '')
}

/**
 * Strip markdown regions that are not the document author's own assertions.
 * Fenced blocks are examples, and blockquotes are quoted prose.
 */
function stripMarkdownNonAssertions(body: string): string {
  return stripFencedCodeBlocks(body).replace(/^[ \t]*>[^\n]*(?:\n|$)/gm, '')
}

/**
 * Check that every bundled skill whose body references the literal `$ARGUMENTS`
 * outside fenced code blocks or blockquotes also declares a non-empty
 * `argument-hint` field in its frontmatter. Skills that only document
 * `$ARGUMENTS` inside code fences or blockquotes are not flagged -- the
 * non-assertion stripping pass removes those occurrences first.
 */
export function checkArgumentHint(
  rootDir: string,
  markdownFiles: readonly string[],
): ArgumentHintViolation[] {
  const violations: ArgumentHintViolation[] = []

  for (const relPath of markdownFiles) {
    if (!isSkillEntryFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue
    const parsed = parseFrontmatter(content)
    if (!isRecord(parsed.data)) continue

    const strippedBody = stripMarkdownNonAssertions(parsed.body)
    if (!strippedBody.includes('$ARGUMENTS')) continue

    const hint = parsed.data['argument-hint']
    if (typeof hint === 'string' && hint.trim() !== '') continue

    violations.push({
      file: relPath,
      message:
        `Skill body references \`$ARGUMENTS\` outside fenced code blocks or blockquotes but frontmatter is missing a non-empty \`argument-hint\` field. ` +
        `Add \`argument-hint: "<description>"\` to the frontmatter so callers know what to pass.`,
    })
  }

  return violations
}

// These are deliberately lexical tokens only; the gate does not attempt to
// detect paraphrases of harness-specific instructions.
const MIGRATED_SKILL_IDENTIFIER_PATTERNS: ReadonlyArray<{
  identifier: MigratedSkillIdentifier
  pattern: RegExp
}> = [
  { identifier: 'task(', pattern: /(?:^|[^A-Za-z0-9_])task\(/ },
  {
    identifier: 'subagent_type',
    pattern: /(?:^|[^A-Za-z0-9_])subagent_type(?:$|[^A-Za-z0-9_])/,
  },
  {
    identifier: 'todowrite',
    pattern: /(?:^|[^A-Za-z0-9_])todowrite(?:$|[^A-Za-z0-9_])/,
  },
  {
    identifier: 'TodoWrite',
    pattern: /(?:^|[^A-Za-z0-9_])TodoWrite(?:$|[^A-Za-z0-9_])/,
  },
  {
    identifier: 'request_user_input',
    pattern: /(?:^|[^A-Za-z0-9_])request_user_input(?:$|[^A-Za-z0-9_])/,
  },
  {
    identifier: 'ask_user',
    pattern: /(?:^|[^A-Za-z0-9_])ask_user(?:$|[^A-Za-z0-9_])/,
  },
  {
    identifier: 'AskUserQuestion',
    pattern: /(?:^|[^A-Za-z0-9_])AskUserQuestion(?:$|[^A-Za-z0-9_])/,
  },
  {
    identifier: 'update_plan',
    pattern: /(?:^|[^A-Za-z0-9_])update_plan(?:$|[^A-Za-z0-9_])/,
  },
  { identifier: 'question', pattern: /`question`/ },
]

const MIGRATED_IDENTIFIER_REMEDIATION =
  'rephrase as a neutral operation; exact syntax belongs in the harness profile (skills/using-systematic/references/)'

/**
 * Scan migrated skill bodies strictly, including fenced code. Harness profile
 * files are the designated home for these identifiers and are fully exempt;
 * this gate protects migrated skill bodies only. A line containing both
 * `in OpenCode` and `in Pi` is the sanctioned interaction idiom and is exempt.
 * The scope is intentionally lexical: paraphrases are not detected.
 */
export function checkMigratedSkillIdentifiers(
  rootDir: string,
  scanFiles: readonly string[],
): MigratedSkillIdentifierViolation[] {
  const violations: MigratedSkillIdentifierViolation[] = []

  for (const relPath of scanFiles) {
    if (isHarnessProfileFile(relPath)) continue
    const content = readFileSafe(path.join(rootDir, relPath))
    if (content === null) continue

    if (!isSkillEntryFile(relPath)) continue
    const parsed = parseFrontmatter(content)
    if (!isMigratedSkill(parsed.data)) continue
    scanMigratedIdentifierFrontmatter(relPath, content, parsed.data, violations)
    scanMigratedIdentifierBody(relPath, content, parsed.body, violations)
  }

  return violations
}

function isHarnessProfileFile(relPath: string): boolean {
  return /^skills\/using-systematic\/references\/[^/]+-profile\.md$/.test(
    relPath,
  )
}

function isMigratedSkill(data: Record<string, unknown>): boolean {
  const metadata = data.metadata
  if (!isRecord(metadata)) return false
  // This marker is consumed only by this gate; there is no runtime protection to mirror.
  return metadata['harness-portability'] === 'neutral-v1'
}

const SANCTIONED_IDIOM_IDENTIFIERS = new Set<MigratedSkillIdentifier>([
  'question',
  'request_user_input',
  'ask_user',
  'AskUserQuestion',
])

function scanMigratedIdentifierFrontmatter(
  relPath: string,
  content: string,
  data: Record<string, unknown>,
  violations: MigratedSkillIdentifierViolation[],
): void {
  const rawBlock = extractFrontmatterBlock(content)
  if (rawBlock === null) return
  const rawLines = rawBlock.split('\n')

  for (const field of ['description', 'argument-hint'] as const) {
    const value = data[field]
    if (typeof value !== 'string') continue
    const rawLineIndex = rawLines.findIndex((line) =>
      new RegExp(`^${escapeRegex(field)}:`).test(line),
    )
    const lineNumber = rawLineIndex >= 0 ? rawLineIndex + 2 : 2
    scanMigratedIdentifierLine(relPath, value, lineNumber, violations)
  }
}

function scanMigratedIdentifierBody(
  relPath: string,
  content: string,
  body: string,
  violations: MigratedSkillIdentifierViolation[],
): void {
  const bodyStart = content.length - body.length
  const lineOffset = content.slice(0, bodyStart).split('\n').length - 1
  for (const [index, line] of body.split('\n').entries()) {
    scanMigratedIdentifierLine(
      relPath,
      line,
      lineOffset + index + 1,
      violations,
    )
  }
}

function scanMigratedIdentifierLine(
  relPath: string,
  line: string,
  lineNumber: number,
  violations: MigratedSkillIdentifierViolation[],
): void {
  const sanctionedIdiom = line.includes('in OpenCode') && line.includes('in Pi')
  for (const { identifier, pattern } of MIGRATED_SKILL_IDENTIFIER_PATTERNS) {
    if (sanctionedIdiom && SANCTIONED_IDIOM_IDENTIFIERS.has(identifier))
      continue
    if (!pattern.test(line)) continue
    violations.push({
      file: relPath,
      line: lineNumber,
      identifier,
      lineContent: line.trim(),
      message: `Migrated skill identifier \`${identifier}\` found in ${relPath}: ${MIGRATED_IDENTIFIER_REMEDIATION}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Removed-names overlap gate
// ---------------------------------------------------------------------------

/**
 * Assert that removed-name lists have no overlap with current bundled names.
 *
 * A removed name must never shadow a live bundled name. If a name appears in
 * both the removed list and the current bundled set, it would be accepted by
 * the schema even if it were re-added to the catalog, silently bypassing
 * strict validation. This gate prevents that drift.
 *
 * Parameters are explicit rather than reading module-level constants so the
 * function is testable with synthetic name sets.
 */
export function checkRemovedNamesOverlap(
  removedSkillNames: readonly string[],
  removedAgentNames: readonly string[],
  currentSkillNames: readonly string[],
  currentAgentNames: readonly string[],
  currentQualifiedAgentIds: readonly string[],
): RemovedNamesOverlapViolation[] {
  const violations: RemovedNamesOverlapViolation[] = []

  const currentSkillSet = new Set(currentSkillNames)
  for (const name of removedSkillNames) {
    if (currentSkillSet.has(name)) {
      violations.push({
        kind: 'skill',
        name,
        message:
          `Removed skill name "${name}" overlaps with a current bundled skill name. ` +
          'Remove it from REMOVED_BUNDLED_SKILL_NAMES or delete it from the bundled catalog first.',
      })
    }
  }

  const currentAgentSet = new Set([
    ...currentAgentNames,
    ...currentQualifiedAgentIds,
  ])
  for (const name of removedAgentNames) {
    if (currentAgentSet.has(name)) {
      violations.push({
        kind: 'agent',
        name,
        message:
          `Removed agent name "${name}" overlaps with a current bundled agent name or qualified id. ` +
          'Remove it from REMOVED_BUNDLED_AGENT_NAMES or delete it from the bundled catalog first.',
      })
    }
  }

  return violations
}

function isAgentFile(relPath: string): boolean {
  const parts = relPath.split('/')
  return (
    parts.length === 3 &&
    parts[0] === 'agents' &&
    parts[2]?.endsWith('.md') === true &&
    (parts[1]?.length ?? 0) > 0
  )
}

function isSkillEntryFile(relPath: string): boolean {
  // Match `skills/<name>/SKILL.md` exactly; skip nested files.
  const parts = relPath.split('/')
  return (
    parts.length === 3 &&
    parts[0] === 'skills' &&
    parts[2] === 'SKILL.md' &&
    (parts[1]?.length ?? 0) > 0
  )
}

// ---------------------------------------------------------------------------
// Banned-pattern check
// ---------------------------------------------------------------------------

export function checkBannedPatterns(
  rootDir: string,
  scanFiles: readonly string[],
  allowlist: AllowlistFile,
): { hits: BannedPatternHit[]; exempt: ExemptHit[] } {
  const hits: BannedPatternHit[] = []
  const exempt: ExemptHit[] = []

  for (const relPath of scanFiles) {
    const absPath = path.join(rootDir, relPath)
    const content = readFileSafe(absPath)
    if (content === null) continue
    scanFileForBanned(relPath, content, allowlist, hits, exempt)
  }

  return { hits, exempt }
}

function scanFileForBanned(
  relPath: string,
  content: string,
  allowlist: AllowlistFile,
  hits: BannedPatternHit[],
  exempt: ExemptHit[],
): void {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const pattern of BANNED_PATTERNS) {
      if (!line.includes(pattern)) continue
      const exemption = findExemption(relPath, pattern, allowlist)
      if (exemption) {
        exempt.push({
          file: relPath,
          line: i + 1,
          pattern,
          reason: exemption.reason,
        })
      } else {
        hits.push({
          file: relPath,
          line: i + 1,
          pattern,
          lineContent: line.trim(),
        })
      }
    }
  }
}

function findExemption(
  filePath: string,
  pattern: BannedPattern,
  allowlist: AllowlistFile,
): AllowlistEntry | null {
  for (const entry of allowlist.exemptions) {
    if (!matchesPathGlob(filePath, entry.pathGlob)) continue
    if (entry.patterns.includes(pattern)) return entry
  }
  return null
}

// ---------------------------------------------------------------------------
// Top-level check
// ---------------------------------------------------------------------------

/**
 * Run the full content-integrity check against `rootDir`. Returns a structured
 * result; does not throw on content violations (callers decide policy). Throws
 * only on malformed allowlist / filesystem errors.
 */
export function checkContentIntegrity(rootDir: string): CheckResult {
  const categories = discoverCategories(rootDir)
  const targets = collectScanTargets(rootDir)
  // allScannedFiles feeds banned-pattern enforcement and allowlist warnings.
  // solutionMarkdown is intentionally excluded: historical solution docs may
  // legitimately reference CC/CEP terms and must not trigger banned-pattern hits.
  const allScannedFiles = [...targets.markdown, ...targets.typescript]

  const { allowlist, warnings: allowlistWarnings } = loadAllowlist(
    rootDir,
    allScannedFiles,
  )

  const phantomRefs = checkReferenceIntegrity(
    rootDir,
    targets.markdown,
    categories,
  )
  const phantomSkillRefs = checkSkillReferenceIntegrity(
    rootDir,
    targets.markdown,
  )
  const brokenSubfileRefs = checkSubfileReferences(rootDir, targets.markdown)
  const frontmatterViolations = checkFrontmatter(rootDir, targets.markdown)
  const parseSafetyViolations = checkFrontmatterParseSafety(
    rootDir,
    targets.solutionMarkdown,
  )
  const agentModelViolations = checkAgentModel(rootDir, targets.markdown)
  const agentModeViolations = checkAgentMode(rootDir, targets.markdown)
  const agentColorViolations = checkAgentColors(rootDir, targets.markdown)
  const agentStemViolations = checkAgentStemUniqueness(
    rootDir,
    targets.markdown,
  )
  const dispatchIdentifierViolations = checkDispatchIdentifiers(
    rootDir,
    targets.markdown,
  )
  const agentTemperatureViolations = checkAgentTemperature(
    rootDir,
    targets.markdown,
  )
  const argumentHintViolations = checkArgumentHint(rootDir, targets.markdown)
  const migratedSkillIdentifierViolations = checkMigratedSkillIdentifiers(
    rootDir,
    targets.markdown,
  )
  const removedNamesOverlapViolations = checkRemovedNamesOverlap(
    REMOVED_BUNDLED_SKILL_NAMES,
    REMOVED_BUNDLED_AGENT_NAMES,
    BUNDLED_SKILL_NAMES,
    BUNDLED_AGENT_NAMES,
    BUNDLED_AGENT_QUALIFIED_IDS,
  )
  const hookParityViolations = checkHookParity(rootDir, targets.rootDocuments)
  const codemapCompletenessViolations = checkCodemapCompleteness(rootDir)
  const { hits: bannedPatterns, exempt: exemptHits } = checkBannedPatterns(
    rootDir,
    allScannedFiles,
    allowlist,
  )

  return {
    rootDir,
    categories,
    allowlistWarnings,
    phantomRefs,
    phantomSkillRefs,
    brokenSubfileRefs,
    bannedPatterns,
    frontmatterViolations,
    parseSafetyViolations,
    agentModelViolations,
    agentModeViolations,
    agentColorViolations,
    agentStemViolations,
    dispatchIdentifierViolations,
    agentTemperatureViolations,
    argumentHintViolations,
    migratedSkillIdentifierViolations,
    removedNamesOverlapViolations,
    hookParityViolations,
    codemapCompletenessViolations,
    exemptHits,
    scanStats: {
      markdownFiles: targets.markdown.length,
      typescriptFiles: targets.typescript.length,
      solutionMarkdownFiles: targets.solutionMarkdown.length,
      rootDocuments: targets.rootDocuments.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readFileSafe(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// CLI main()
// ---------------------------------------------------------------------------

function printResult(result: CheckResult, verbose: boolean): void {
  // Warnings first (non-fatal, routed to stderr so CI can surface them)
  for (const w of result.allowlistWarnings) {
    process.stderr.write(`drift-allowlist warning: ${w.message}\n`)
  }

  printPhantomRefs(result.phantomRefs)
  printPhantomSkillRefs(result.phantomSkillRefs)
  printBrokenSubfileRefs(result.brokenSubfileRefs)
  printBannedPatterns(result.bannedPatterns)
  printFrontmatterViolations(result.frontmatterViolations)
  printFrontmatterViolations(
    result.parseSafetyViolations,
    'Parse-safety violations',
  )
  printAgentModelViolations(result.agentModelViolations)
  printAgentModeViolations(result.agentModeViolations)
  printAgentColorViolations(result.agentColorViolations)
  printAgentStemViolations(result.agentStemViolations)
  printDispatchIdentifierViolations(result.dispatchIdentifierViolations)
  printAgentTemperatureViolations(result.agentTemperatureViolations)
  printArgumentHintViolations(result.argumentHintViolations)
  printMigratedSkillIdentifierViolations(
    result.migratedSkillIdentifierViolations,
  )
  printRemovedNamesOverlapViolations(result.removedNamesOverlapViolations)
  printHookParityViolations(result.hookParityViolations)
  printCodemapCompletenessViolations(result.codemapCompletenessViolations)

  if (totalViolations(result) === 0) {
    process.stdout.write(
      `content-integrity: clean (${result.scanStats.markdownFiles} md + ` +
        `${result.scanStats.typescriptFiles} ts + ` +
        `${result.scanStats.solutionMarkdownFiles} solution-md + ` +
        `${result.scanStats.rootDocuments} root docs scanned, ` +
        `${result.exemptHits.length} exempt hits, ` +
        `${result.allowlistWarnings.length} warnings)\n`,
    )
  }

  if (verbose) {
    process.stdout.write(
      `\ncategories: ${result.categories.join(', ')}\n` +
        `scanStats: ${result.scanStats.markdownFiles} md + ${result.scanStats.typescriptFiles} ts + ${result.scanStats.solutionMarkdownFiles} solution-md + ${result.scanStats.rootDocuments} root docs\n` +
        `frontmatterViolations: ${result.frontmatterViolations.length}\n` +
        `parseSafetyViolations: ${result.parseSafetyViolations.length}\n` +
        `agentModelViolations: ${result.agentModelViolations.length}\n` +
        `agentModeViolations: ${result.agentModeViolations.length}\n` +
        `agentColorViolations: ${result.agentColorViolations.length}\n` +
        `agentStemViolations: ${result.agentStemViolations.length}\n` +
        `dispatchIdentifierViolations: ${result.dispatchIdentifierViolations.length}\n` +
        `hookParityViolations: ${result.hookParityViolations.length}\n` +
        `exemptHits: ${result.exemptHits.length}\n`,
    )
  }
}

function printPhantomRefs(phantomRefs: readonly PhantomRef[]): void {
  if (phantomRefs.length === 0) return
  process.stderr.write(`\nPhantom references (${phantomRefs.length}):\n`)
  for (const p of phantomRefs) {
    process.stderr.write(
      `  ${p.file}:${p.line}  ${p.reference}  (no such agent: agents/${p.category}/${p.name}.md)\n`,
    )
  }
}

function printPhantomSkillRefs(
  phantomSkillRefs: readonly PhantomSkillRef[],
): void {
  if (phantomSkillRefs.length === 0) return
  process.stderr.write(
    `\nPhantom skill references (${phantomSkillRefs.length}):\n`,
  )
  for (const p of phantomSkillRefs) {
    process.stderr.write(
      `  ${p.file}:${p.line}  ${p.reference}  (no such skill: skills/ce-${p.name}/)\n`,
    )
  }
}

function printBrokenSubfileRefs(refs: readonly BrokenSubfileRef[]): void {
  if (refs.length === 0) return
  process.stderr.write(`\nBroken sub-file references (${refs.length}):\n`)
  for (const r of refs) {
    process.stderr.write(
      `  ${r.file}:${r.line}  ${r.reference}  (no such file: ${r.resolvedPath})\n`,
    )
  }
}

function printBannedPatterns(hits: readonly BannedPatternHit[]): void {
  if (hits.length === 0) return
  process.stderr.write(
    `\nBanned patterns outside allowlist (${hits.length}):\n`,
  )
  for (const h of hits) {
    process.stderr.write(
      `  ${h.file}:${h.line}  ${JSON.stringify(h.pattern)}  ${h.lineContent}\n`,
    )
  }
}

function printFrontmatterViolations(
  violations: readonly FrontmatterViolation[],
  label = 'Frontmatter violations',
): void {
  if (violations.length === 0) return
  process.stderr.write(`\n${label} (${violations.length}):\n`)
  for (const v of violations) {
    const field = v.field ? ` (${v.field})` : ''
    process.stderr.write(`  ${v.file}  ${v.rule}${field}: ${v.message}\n`)
    process.stderr.write(`    fix: ${v.remediation}\n`)
  }
}

function printAgentModelViolations(
  violations: readonly AgentModelViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(`\nAgent model violations (${violations.length}):\n`)
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  ${v.message}\n`)
  }
}

function printAgentModeViolations(
  violations: readonly AgentModeViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(`\nAgent mode violations (${violations.length}):\n`)
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  ${v.message}\n`)
  }
}

function printAgentColorViolations(
  violations: readonly AgentColorViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(`\nAgent color violations (${violations.length}):\n`)
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  ${v.message}\n`)
  }
}

function printAgentStemViolations(
  violations: readonly AgentStemViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nDuplicate bundled agent stems (${violations.length}):\n`,
  )
  for (const v of violations) {
    process.stderr.write(`  ${v.stem}  ${v.message}\n`)
    for (const file of v.files) {
      process.stderr.write(`    ${file}\n`)
    }
  }
}

function printDispatchIdentifierViolations(
  violations: readonly DispatchIdentifierViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nDispatch identifier violations (${violations.length}):\n`,
  )
  for (const v of violations) {
    process.stderr.write(
      `  [${v.kind}] ${v.file}:${v.line}  ${v.identifier}  ${v.message}\n`,
    )
  }
}

function printAgentTemperatureViolations(
  violations: readonly AgentTemperatureViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nAgent temperature violations (${violations.length}):\n`,
  )
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  ${v.message}\n`)
  }
}

function printArgumentHintViolations(
  violations: readonly ArgumentHintViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(`\nArgument-hint violations (${violations.length}):\n`)
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  ${v.message}\n`)
  }
}

function printMigratedSkillIdentifierViolations(
  violations: readonly MigratedSkillIdentifierViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nMigrated skill identifier violations (${violations.length}):\n`,
  )
  for (const v of violations) {
    process.stderr.write(
      `  ${v.file}:${v.line}  ${v.identifier}  ${v.message}\n`,
    )
  }
}

function printRemovedNamesOverlapViolations(
  violations: readonly RemovedNamesOverlapViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nRemoved-names overlap violations (${violations.length}):\n`,
  )
  for (const v of violations) {
    process.stderr.write(`  [${v.kind}] ${v.name}  ${v.message}\n`)
  }
}

function printHookParityViolations(
  violations: readonly HookParityViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nPlugin hook parity violations (${violations.length}):\n`,
  )
  for (const violation of violations) {
    process.stderr.write(`  ${violation.message}\n`)
  }
}

function printCodemapCompletenessViolations(
  violations: readonly CodemapCompletenessViolation[],
): void {
  if (violations.length === 0) return
  process.stderr.write(
    `\nArchitecture codemap completeness violations (${violations.length}):\n`,
  )
  for (const violation of violations) {
    process.stderr.write(`  [${violation.kind}] ${violation.message}\n`)
  }
}

function totalViolations(result: CheckResult): number {
  return (
    result.phantomRefs.length +
    result.phantomSkillRefs.length +
    result.brokenSubfileRefs.length +
    result.bannedPatterns.length +
    result.frontmatterViolations.length +
    result.parseSafetyViolations.length +
    result.agentModelViolations.length +
    result.agentModeViolations.length +
    result.agentColorViolations.length +
    result.agentStemViolations.length +
    result.dispatchIdentifierViolations.length +
    result.agentTemperatureViolations.length +
    result.argumentHintViolations.length +
    result.migratedSkillIdentifierViolations.length +
    result.removedNamesOverlapViolations.length +
    result.hookParityViolations.length +
    result.codemapCompletenessViolations.length
  )
}

function main(): number {
  const args = process.argv.slice(2)
  const verbose = args.includes('--verbose') || args.includes('-v')
  const rootArg = args.find((a) => !a.startsWith('-'))

  const rootDir = rootArg ? path.resolve(rootArg) : resolveRepoRoot()

  let result: CheckResult
  try {
    result = checkContentIntegrity(rootDir)
  } catch (err) {
    process.stderr.write(`content-integrity: ${(err as Error).message}\n`)
    return 1
  }

  printResult(result, verbose)

  const violationCount = totalViolations(result)
  return violationCount > 0 ? 1 : 0
}

function resolveRepoRoot(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '..')
}

// Invoke when run directly (not when imported by tests)
if (import.meta.main) {
  process.exit(main())
}
