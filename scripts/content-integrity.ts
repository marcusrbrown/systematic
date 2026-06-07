#!/usr/bin/env bun
/**
 * Content-Integrity Gate
 *
 * Enforces six content invariants across Systematic's shipped assets:
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
 * Scope is narrow by design: `skills/**\/*.md`, `agents/**\/*.md`, and
 * `src/**\/*.ts` for the full invariant suite. Additionally, `docs/solutions/**\/*.md`
 * is scanned for frontmatter parse-safety only (flags any unquoted inline comment —
 * whitespace-before-`#` or value-start `#` — in frontmatter; remediation is to quote
 * the value or remove the comment). The gate does not scan `.opencode/`, `.github/`,
 * `dist/`, `node_modules/`, `registry/`, or markdown files under `src/` —
 * those intentionally contain historical or documented CC/CEP references.
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
  extractFrontmatterBlock,
  parseFrontmatter,
} from '../src/lib/frontmatter.js'
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
    | 'deprecated-reason-missing'
    | 'deprecated-missing-required-fields'
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

export interface AgentTemperatureViolation {
  file: string
  message: string
}

export interface CheckResult {
  rootDir: string
  categories: string[]
  allowlistWarnings: AllowlistWarning[]
  phantomRefs: PhantomRef[]
  brokenSubfileRefs: BrokenSubfileRef[]
  bannedPatterns: BannedPatternHit[]
  frontmatterViolations: FrontmatterViolation[]
  parseSafetyViolations: FrontmatterViolation[]
  agentModelViolations: AgentModelViolation[]
  agentModeViolations: AgentModeViolation[]
  agentColorViolations: AgentColorViolation[]
  agentStemViolations: AgentStemViolation[]
  agentTemperatureViolations: AgentTemperatureViolation[]
  exemptHits: ExemptHit[]
  scanStats: {
    markdownFiles: number
    typescriptFiles: number
    solutionMarkdownFiles: number
  }
}

const ALLOWED_SKILL_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(
  SKILL_FRONTMATTER_FIELDS,
)

const BANNED_SKILL_FRONTMATTER_FIELDS = new Set(['preconditions'])
const FRONTMATTER_REMEDIATION =
  'Update frontmatter to match systematic:writing-systematic-skills.'

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
}

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

  markdown.sort()
  typescript.sort()
  solutionMarkdown.sort()
  return { markdown, typescript, solutionMarkdown }
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
  checkDeprecatedBlockForBundled(relPath, parsed.data, violations)
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

function checkDeprecatedBlockForBundled(
  relPath: string,
  data: Record<string, unknown>,
  violations: FrontmatterViolation[],
): void {
  if (!isSkillEntryFile(relPath)) return
  if (!Object.hasOwn(data, 'deprecated')) return
  const deprecated = data.deprecated
  if (!isRecord(deprecated)) return

  const since = deprecated.since
  const removal = deprecated.removal
  const sinceMissing = typeof since !== 'string' || since.trim() === ''
  const removalMissing = typeof removal !== 'string' || removal.trim() === ''
  if (sinceMissing || removalMissing) {
    const missingFields = [
      sinceMissing ? 'deprecated.since' : null,
      removalMissing ? 'deprecated.removal' : null,
    ]
      .filter(Boolean)
      .join(', ')
    violations.push({
      file: relPath,
      rule: 'deprecated-missing-required-fields',
      field: missingFields,
      message: `Bundled skill deprecated block must include non-empty string fields: ${missingFields}. The runtime silently drops the entire deprecated block when these are missing, defeating the deprecation cycle.`,
      remediation: FRONTMATTER_REMEDIATION,
    })
  }

  const reason = deprecated.reason
  if (typeof reason === 'string' && reason.trim() !== '') return
  violations.push({
    file: relPath,
    rule: 'deprecated-reason-missing',
    field: 'deprecated.reason',
    message:
      'Bundled skill deprecated block must include a non-empty reason string.',
    remediation: FRONTMATTER_REMEDIATION,
  })
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
          "Bundled agents must declare `mode: subagent` explicitly. The converter's fill-if-absent default will be removed in v3.0.0; without an explicit `mode`, agents would fall back to OpenCode's native default (`all`), making internal agents primary-visible.",
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
    if (!isRecord(parsed.data) || !Object.hasOwn(parsed.data, 'temperature')) {
      violations.push({
        file: relPath,
        message:
          'Bundled agents must declare an explicit `temperature:` in frontmatter. ' +
          'The runtime fill-if-absent fallback (`inferBuiltInTemperature`) will be removed in v3.0.0; ' +
          'without an explicit `temperature:`, agents would lose their tuned value.',
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
  const agentTemperatureViolations = checkAgentTemperature(
    rootDir,
    targets.markdown,
  )
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
    brokenSubfileRefs,
    bannedPatterns,
    frontmatterViolations,
    parseSafetyViolations,
    agentModelViolations,
    agentModeViolations,
    agentColorViolations,
    agentStemViolations,
    agentTemperatureViolations,
    exemptHits,
    scanStats: {
      markdownFiles: targets.markdown.length,
      typescriptFiles: targets.typescript.length,
      solutionMarkdownFiles: targets.solutionMarkdown.length,
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
  printAgentTemperatureViolations(result.agentTemperatureViolations)

  if (totalViolations(result) === 0) {
    process.stdout.write(
      `content-integrity: clean (${result.scanStats.markdownFiles} md + ` +
        `${result.scanStats.typescriptFiles} ts + ` +
        `${result.scanStats.solutionMarkdownFiles} solution-md scanned, ` +
        `${result.exemptHits.length} exempt hits, ` +
        `${result.allowlistWarnings.length} warnings)\n`,
    )
  }

  if (verbose) {
    process.stdout.write(
      `\ncategories: ${result.categories.join(', ')}\n` +
        `scanStats: ${result.scanStats.markdownFiles} md + ${result.scanStats.typescriptFiles} ts + ${result.scanStats.solutionMarkdownFiles} solution-md\n` +
        `frontmatterViolations: ${result.frontmatterViolations.length}\n` +
        `parseSafetyViolations: ${result.parseSafetyViolations.length}\n` +
        `agentModelViolations: ${result.agentModelViolations.length}\n` +
        `agentModeViolations: ${result.agentModeViolations.length}\n` +
        `agentColorViolations: ${result.agentColorViolations.length}\n` +
        `agentStemViolations: ${result.agentStemViolations.length}\n` +
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

function totalViolations(result: CheckResult): number {
  return (
    result.phantomRefs.length +
    result.brokenSubfileRefs.length +
    result.bannedPatterns.length +
    result.frontmatterViolations.length +
    result.parseSafetyViolations.length +
    result.agentModelViolations.length +
    result.agentModeViolations.length +
    result.agentColorViolations.length +
    result.agentStemViolations.length +
    result.agentTemperatureViolations.length
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
