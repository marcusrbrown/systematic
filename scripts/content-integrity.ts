#!/usr/bin/env bun
/**
 * Content-Integrity Gate
 *
 * Enforces two content invariants across Systematic's shipped assets:
 *
 * 1. **Reference integrity** — every `systematic:<category>:<name>` reference
 *    in bundled skills and agents resolves to an actual `agents/<category>/<name>.md`
 *    file. Catches phantom dispatch directives left over from sync operations or
 *    sub-agent bulk edits.
 *
 * 2. **Banned-pattern scan** — a fixed list of CC/CEP strings (branding, tool
 *    names, plugin prefix, paths, env vars) appears only inside documented
 *    allowlist entries. Catches accidental reintroduction of Claude Code or
 *    Compound Engineering refs after the v2.4.0 divorce.
 *
 * Scope is narrow by design: `skills/**\/*.md`, `agents/**\/*.md`, and
 * `src/**\/*.ts`. The gate does not scan `docs/`, `.opencode/`, `.github/`,
 * `dist/`, `node_modules/`, `registry/`, or markdown files under `src/` —
 * those intentionally contain historical or documented CC/CEP references.
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
import { walkDir } from '../src/lib/walk-dir.js'

// ---------------------------------------------------------------------------
// Banned-pattern list (R2)
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
// Allowlist types (R4, R5)
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

export interface CheckResult {
  rootDir: string
  categories: string[]
  allowlistWarnings: AllowlistWarning[]
  phantomRefs: PhantomRef[]
  bannedPatterns: BannedPatternHit[]
  exemptHits: ExemptHit[]
  scanStats: {
    markdownFiles: number
    typescriptFiles: number
  }
}

// ---------------------------------------------------------------------------
// Allowlist loader (R4, R5)
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
    return filePath === prefix || filePath.startsWith(`${prefix}/`)
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
  // A prefix is "specific" when it has at least one non-empty path segment
  // (e.g., `skills/foo` is specific; `skills` alone is too broad because it
  // exempts every skill).
  return prefix.split('/').filter((s) => s.length > 0).length < 2
}

// ---------------------------------------------------------------------------
// Category discovery (R1)
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
// Scan-target collection (R6)
// ---------------------------------------------------------------------------

export interface ScanTargets {
  markdown: string[] // repo-relative paths under skills/ and agents/
  typescript: string[] // repo-relative paths under src/ (excluding markdown)
}

/**
 * Collect the files the gate scans. Paths are repo-relative for consistent
 * allowlist matching.
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

  markdown.sort()
  typescript.sort()
  return { markdown, typescript }
}

// ---------------------------------------------------------------------------
// Reference-integrity check (R1)
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
// Banned-pattern check (R2, R6)
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
    bannedPatterns,
    exemptHits,
    scanStats: {
      markdownFiles: targets.markdown.length,
      typescriptFiles: targets.typescript.length,
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

  if (result.phantomRefs.length > 0) {
    process.stderr.write(
      `\nPhantom references (${result.phantomRefs.length}):\n`,
    )
    for (const p of result.phantomRefs) {
      process.stderr.write(
        `  ${p.file}:${p.line}  ${p.reference}  (no such agent: agents/${p.category}/${p.name}.md)\n`,
      )
    }
  }

  if (result.bannedPatterns.length > 0) {
    process.stderr.write(
      `\nBanned patterns outside allowlist (${result.bannedPatterns.length}):\n`,
    )
    for (const h of result.bannedPatterns) {
      process.stderr.write(
        `  ${h.file}:${h.line}  ${JSON.stringify(h.pattern)}  ${h.lineContent}\n`,
      )
    }
  }

  if (result.phantomRefs.length === 0 && result.bannedPatterns.length === 0) {
    process.stdout.write(
      `content-integrity: clean (${result.scanStats.markdownFiles} md + ` +
        `${result.scanStats.typescriptFiles} ts scanned, ` +
        `${result.exemptHits.length} exempt hits, ` +
        `${result.allowlistWarnings.length} warnings)\n`,
    )
  }

  if (verbose) {
    process.stdout.write(
      `\ncategories: ${result.categories.join(', ')}\n` +
        `scanStats: ${result.scanStats.markdownFiles} md + ${result.scanStats.typescriptFiles} ts\n` +
        `exemptHits: ${result.exemptHits.length}\n`,
    )
  }
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

  const violationCount =
    result.phantomRefs.length + result.bannedPatterns.length
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
