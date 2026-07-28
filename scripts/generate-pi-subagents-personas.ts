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
import { parseFrontmatter } from '../src/lib/frontmatter.js'

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

// ── Types ─────────────────────────────────────────────────────────────────────

/** Compatibility severity: info = fully usable, warning = may differ, critical = excluded. */
export type CompatibilitySeverity = 'info' | 'warning' | 'critical'

/** Result of classifying a persona's pi-subagents compatibility. */
export interface CompatibilityStatus {
  severity: CompatibilitySeverity
  /** Human-readable reasons for the severity (empty for info). */
  reasons: string[]
}

/** Per-persona entry in the manifest. */
export interface ManifestEntry {
  /** Emitted filename, e.g. `systematic-best-practices-researcher.md`. */
  filename: string
  /** Export status. */
  status: 'exported' | 'exported-with-warning' | 'excluded-critical'
  /** Repo-relative source path, e.g. `agents/research/best-practices-researcher.md`. */
  sourceRelPath: string
  /** SHA-256 hex of the generated content (only for exported entries). */
  hash: string
  /** Generated content (only for exported entries). */
  content?: string
  /** Human-readable reason (for excluded-critical and exported-with-warning). */
  reason?: string
}

/** The full manifest written alongside the generated persona files. */
export interface PersonaManifest {
  /** ISO timestamp of when this manifest was generated. */
  generatedAt: string
  entries: ManifestEntry[]
}

/** Result of a drift check. */
export interface DriftCheckResult {
  ok: boolean
  staleFiles: string[]
  messages: string[]
}

// ── Curated persona list ──────────────────────────────────────────────────────

/**
 * The authoritative curated-include list with per-persona compatibility
 * rationale. Only personas in this list are candidates for export.
 *
 * Exclude-over-transform: personas with critical Systematic-only coupling
 * are absent from this list (see EXCLUDED_RATIONALE below for documentation).
 *
 * Exclusion rationale (not in list):
 *   - agents/workflow/systematic-implementer.md — CRITICAL: dispatched-by-parent
 *     assumption baked into the persona role; violates the parent-dispatch/load-skill
 *     exclusion criterion.
 *   - agents/design/design-iterator.md — CRITICAL: requires `agent-browser` tool +
 *     explicit `systematic:frontend-design` skill load instruction.
 *   - agents/review/agent-native-reviewer.md — CRITICAL: deep Systematic/OpenCode-specific
 *     codebase context; references Systematic's own agent/skill namespace directly.
 *   - agents/review/project-standards-reviewer.md — CRITICAL: requires `<standards-paths>`
 *     block injected by the Systematic orchestrator.
 *   - agents/review/kieran-typescript-reviewer.md — WARNING: opinionated persona;
 *     excluded by plan recommendation (keep list broad but safe).
 *   - agents/research/slack-researcher.md — CRITICAL: requires Slack MCP environment;
 *     fails gracefully but is fundamentally env-coupled.
 *   - agents/research/learnings-researcher.md — CRITICAL: directly references
 *     `../../skills/ce-compound/references/yaml-schema.md` (Systematic skill path).
 *   - agents/workflow/pr-comment-resolver.md — WARNING: frontmatter description says
 *     "Spawned by the resolve-pr-feedback skill"; parent-dispatch coupling.
 */
export interface CuratedPersonaEntry {
  /** Repo-relative path, e.g. `agents/research/best-practices-researcher.md`. */
  relPath: string
  /** Why this persona is suitable for export (compatibility rationale). */
  rationale: string
}

export const CURATED_PERSONAS: CuratedPersonaEntry[] = [
  // ── research ──────────────────────────────────────────────────────────────
  {
    relPath: 'agents/research/best-practices-researcher.md',
    rationale:
      'Self-contained research persona. INFO: mentions skills in prose as discovery hints, but is operationally independent — no load-skill directive, no parent-dispatch assumption.',
  },
  {
    relPath: 'agents/research/framework-docs-researcher.md',
    rationale:
      'Self-contained framework documentation researcher. No Systematic-only coupling; uses standard tools (Context7, web search, file reads).',
  },
  {
    relPath: 'agents/research/git-history-analyzer.md',
    rationale:
      'Self-contained git archaeology persona. Uses only standard git CLI + file tools. No skill or orchestration dependencies.',
  },
  {
    relPath: 'agents/research/issue-intelligence-analyst.md',
    rationale:
      'Self-contained GitHub issue analysis persona. Requires only gh CLI + standard file tools. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/research/repo-research-analyst.md',
    rationale:
      'Self-contained repository research persona. Uses standard file/search/glob tools. No Systematic-specific orchestration.',
  },

  // ── review ────────────────────────────────────────────────────────────────
  {
    relPath: 'agents/review/adversarial-reviewer.md',
    rationale:
      'Self-contained adversarial code reviewer. Fully portable — no Systematic tools or skills required.',
  },
  {
    relPath: 'agents/review/api-contract-reviewer.md',
    rationale:
      'Self-contained API contract reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/architecture-strategist.md',
    rationale:
      'Self-contained architectural reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/cli-readiness-reviewer.md',
    rationale:
      'Self-contained CLI readiness reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/code-simplicity-reviewer.md',
    rationale:
      'Self-contained code simplicity reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/correctness-reviewer.md',
    rationale:
      'Self-contained correctness reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/data-migrations-reviewer.md',
    rationale:
      'Self-contained data migrations reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/deployment-verification-agent.md',
    rationale:
      'Self-contained deployment verification persona. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/maintainability-reviewer.md',
    rationale:
      'Self-contained maintainability reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/pattern-recognition-specialist.md',
    rationale:
      'Self-contained pattern recognition reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/performance-reviewer.md',
    rationale:
      'Self-contained performance reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/previous-comments-reviewer.md',
    rationale:
      'Self-contained previous-comments reviewer. Reviews prior feedback. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/reliability-reviewer.md',
    rationale:
      'Self-contained reliability reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/security-reviewer.md',
    rationale: 'Self-contained security reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/review/testing-reviewer.md',
    rationale: 'Self-contained testing reviewer. No Systematic-only coupling.',
  },

  // ── document-review ───────────────────────────────────────────────────────
  {
    relPath: 'agents/document-review/adversarial-document-reviewer.md',
    rationale:
      'Self-contained document reviewer. Challenges premises in plans/specs. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/document-review/coherence-reviewer.md',
    rationale:
      'Self-contained document coherence reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/document-review/design-lens-reviewer.md',
    rationale:
      'Self-contained design lens reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/document-review/feasibility-reviewer.md',
    rationale:
      'Self-contained feasibility reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/document-review/product-lens-reviewer.md',
    rationale:
      'Self-contained product lens reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/document-review/scope-guardian-reviewer.md',
    rationale:
      'Self-contained scope guardian reviewer. No Systematic-only coupling.',
  },
  {
    relPath: 'agents/document-review/security-lens-reviewer.md',
    rationale:
      'Self-contained security lens reviewer. No Systematic-only coupling.',
  },

  // ── workflow ──────────────────────────────────────────────────────────────
  {
    relPath: 'agents/workflow/spec-flow-analyzer.md',
    rationale:
      'Self-contained spec flow analyzer. Analyzes specs for user flow completeness. No Systematic orchestration coupling.',
  },
  {
    relPath: 'agents/workflow/bug-reproduction-validator.md',
    rationale:
      'Self-contained bug reproduction specialist. WARNING: mentions agent-browser skill in prose as an optional tool hint, but does not require Systematic skill loading to operate.',
  },
]

// ── Name sanitization ─────────────────────────────────────────────────────────

/**
 * Sanitize a persona name for use as a pi-subagents filename stem.
 *
 * Rules:
 *   - Lowercase alphanumeric + hyphen only
 *   - Path separators (/ \) and dots removed entirely (no traversal)
 *   - Spaces and underscores → hyphen
 *   - Collapse multiple hyphens → single
 *   - Strip leading/trailing hyphens
 *
 * Returns empty string if no safe characters remain. Callers must reject
 * an empty result to avoid producing `systematic-.md`.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[/\\]/g, '') // remove path separators
    .replace(/\./g, '') // remove dots
    .replace(/[\s_]+/g, '-') // spaces/underscores → hyphen
    .replace(/[^a-z0-9-]/g, '') // remove everything else
    .replace(/-{2,}/g, '-') // collapse multiple hyphens
    .replace(/^-+|-+$/g, '') // strip leading/trailing hyphens
}

// ── Identity fold (NFC + case) ────────────────────────────────────────────────

/**
 * Canonicalize an identity string for collision detection:
 * NFC-normalized + case-folded so two names differing only by case or
 * Unicode normalization form collide loudly instead of silently overwriting
 * each other on a case-insensitive filesystem (macOS).
 */
function foldIdentity(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

// ── Compatibility screening ───────────────────────────────────────────────────

/**
 * Critical coupling patterns.
 *
 * These are conservative, structural signals — NOT arbitrary text matches.
 * The false-positive avoidance rule: only flag when the pattern indicates
 * a behavioral dependency on Systematic-only infrastructure, not when it
 * appears as innocent prose (e.g. "your task is to...").
 */
const CRITICAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // "dispatched by a parent" — explicit parent-orchestrator assumption
    pattern: /dispatched by a parent/i,
    reason:
      'References parent-dispatch assumption ("dispatched by a parent") — this persona is designed to be orchestrated by Systematic.',
  },
  {
    // "report back to the orchestrator" — parent-dispatch assumption
    pattern: /report(?:ing)? back to the orchestrator/i,
    reason:
      "References orchestrator-report assumption — this persona is designed to operate within Systematic's orchestration loop.",
  },
  {
    // "load the systematic:" (explicit skill load directive)
    pattern: /\bload\s+(?:the\s+)?systematic:/i,
    reason:
      'Contains explicit Systematic skill load directive ("Load systematic:...") — requires Systematic skill loading infrastructure.',
  },
  {
    // "load `systematic:" — backtick variant
    pattern: /load\s+`systematic:/i,
    reason:
      'Contains explicit Systematic skill load directive with backtick form — requires Systematic skill loading infrastructure.',
  },
  {
    // Skills path reference: ../../skills/... (direct Systematic file path)
    pattern: /\.\.(\/|\\)\.\.(?:\/|\\)skills\//,
    reason:
      'Directly references Systematic internal skill paths (../../skills/...) — not portable outside Systematic.',
  },
]

/**
 * Warning patterns — behavior may differ, but persona is still operable.
 */
const WARNING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // "see `agent-browser` skill" or "agent-browser CLI" — optional hint
    pattern: /\bagent-browser\s+(?:CLI|skill)\b/i,
    reason:
      'References agent-browser CLI/skill as an optional tool hint. Behavior may differ if agent-browser is not available, but persona remains operable without it.',
  },
  {
    // "use the agent-browser skill" — explicit suggestion
    pattern: /use\s+(?:the\s+)?agent-browser\s+skill/i,
    reason:
      'Suggests using the agent-browser skill. Persona operates without it but visual verification steps would be skipped.',
  },
]

/**
 * Classify the compatibility of a persona for pi-subagents export.
 *
 * Returns the highest severity found and a list of reasons.
 * Only structural/behavioral coupling patterns are flagged — harmless prose
 * mentions of words like "task" or "delegate" are not critical indicators.
 */
export function classifyCompatibility(content: string): CompatibilityStatus {
  const reasons: string[] = []
  let severity: CompatibilitySeverity = 'info'

  for (const { pattern, reason } of CRITICAL_PATTERNS) {
    if (pattern.test(content)) {
      reasons.push(reason)
      severity = 'critical'
    }
  }

  if (severity !== 'critical') {
    for (const { pattern, reason } of WARNING_PATTERNS) {
      if (pattern.test(content)) {
        reasons.push(reason)
        severity = 'warning'
      }
    }
  }

  return { severity, reasons }
}

// ── Persona content generation ────────────────────────────────────────────────

/**
 * Generate the pi-subagents-compatible content for a persona.
 *
 * pi-subagents v0.14.1 contract:
 *   - Flat .md filename is the agent identity (not frontmatter name)
 *   - Emit `description` only — omit name, model, mode, temperature, color, tools, skills
 *   - Body preserved as-is (no semantic rewrite)
 *
 * Throws if the frontmatter `name` is missing, empty, or sanitizes to empty
 * (which would produce `systematic-.md`). Also returns null when
 * compatibility screening classifies the persona as critical.
 */
export function generatePersonaContent(
  /** Source filename stem or path (used only for error messages). */
  sourceRef: string,
  /** Full raw content of the source .md file. */
  rawContent: string,
): string | null {
  const { data, body, hadFrontmatter } =
    parseFrontmatter<Record<string, unknown>>(rawContent)

  // Require a non-empty frontmatter name
  const rawName = data.name
  if (!hadFrontmatter || rawName === undefined || rawName === null) {
    throw new Error(
      `Persona "${sourceRef}" is missing frontmatter "name" — cannot generate pi-subagents export.`,
    )
  }
  if (typeof rawName !== 'string') {
    throw new Error(
      `Persona "${sourceRef}" has a frontmatter "name" of type ${typeof rawName} (expected a non-empty string).`,
    )
  }
  const trimmedName = rawName.trim()
  if (trimmedName === '') {
    throw new Error(
      `Persona "${sourceRef}" has an empty frontmatter "name" — cannot generate pi-subagents export.`,
    )
  }

  // Guard: sanitized name must not be empty (prevents systematic-.md)
  const sanitized = sanitizeName(trimmedName)
  if (sanitized === '') {
    throw new Error(
      `Persona "${sourceRef}" name "${trimmedName}" sanitizes to an empty string — cannot produce a valid filename. Rename the persona to use alphanumeric characters.`,
    )
  }

  // Compatibility screening
  const compat = classifyCompatibility(rawContent)
  if (compat.severity === 'critical') {
    return null
  }

  // Build the emitted frontmatter: description only, model-free
  const description =
    typeof data.description === 'string' ? data.description : undefined
  const emittedFrontmatter: Record<string, unknown> = {}
  if (description !== undefined && description.trim() !== '') {
    emittedFrontmatter.description = description
  }

  // Serialize frontmatter
  let frontmatterBlock: string
  if (Object.keys(emittedFrontmatter).length === 0) {
    frontmatterBlock = '---\n---'
  } else {
    const lines = Object.entries(emittedFrontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n')
    frontmatterBlock = `---\n${lines}\n---`
  }

  // Preserve body as-is (no semantic rewrite)
  const trimmedBody = body.replace(/^\n+/, '') // trim leading blank lines
  return `${frontmatterBlock}\n\n${trimmedBody}`
}

// ── Manifest generation ───────────────────────────────────────────────────────

/**
 * Generate a manifest entry for a single persona.
 *
 * Throws if the persona name is missing or sanitizes to empty (see
 * `generatePersonaContent` for the same guard). If the persona is critical,
 * the entry has status=excluded-critical and no content.
 */
export function generatePersonaManifest(
  /** Repo-relative source path, e.g. `agents/research/best-practices-researcher.md`. */
  sourceRelPath: string,
  /** Full raw content of the source .md file. */
  rawContent: string,
  /** Repo root (used for error context only; no filesystem writes). */
  _repoRoot: string,
): ManifestEntry {
  const { data } = parseFrontmatter<Record<string, unknown>>(rawContent)
  const rawName = data.name

  // Validate name and sanitize — must not produce empty result
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    throw new Error(
      `Persona "${sourceRelPath}" is missing or has an empty frontmatter "name".`,
    )
  }
  const sanitized = sanitizeName(rawName.trim())
  if (sanitized === '') {
    throw new Error(
      `Persona "${sourceRelPath}" name "${rawName.trim()}" sanitizes to an empty string — cannot produce a valid filename. Rename the persona to use alphanumeric characters.`,
    )
  }

  const filename = `systematic-${sanitized}.md`

  // Compatibility screening
  const compat = classifyCompatibility(rawContent)
  if (compat.severity === 'critical') {
    return {
      filename,
      status: 'excluded-critical',
      sourceRelPath,
      hash: '',
      reason: compat.reasons.join('; '),
    }
  }

  // Generate content (may throw for missing name — redundant guard above handles it)
  const content = generatePersonaContent(sourceRelPath, rawContent)

  // content should not be null here (we already checked compat above)
  if (content === null) {
    return {
      filename,
      status: 'excluded-critical',
      sourceRelPath,
      hash: '',
      reason: 'Compatibility screening rejected persona.',
    }
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex')
  const status: ManifestEntry['status'] =
    compat.severity === 'warning' ? 'exported-with-warning' : 'exported'

  return {
    filename,
    status,
    sourceRelPath,
    hash,
    content,
    reason: compat.reasons.length > 0 ? compat.reasons.join('; ') : undefined,
  }
}

// ── Generate all curated personas ────────────────────────────────────────────

/**
 * Generate all curated personas from the real agents/ dir.
 *
 * Runs compatibility screening, detects filename collisions, and fails
 * loudly if any curated persona is classified critical (new-coupling check).
 *
 * Returns the full set of manifest entries. Pure function — no writes.
 */
export function generateAll(repoRoot: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  const byFoldedFilename = new Map<string, string[]>()

  for (const curatedEntry of CURATED_PERSONAS) {
    const fullPath = path.join(repoRoot, curatedEntry.relPath)
    let rawContent: string
    try {
      rawContent = fs.readFileSync(fullPath, 'utf-8')
    } catch (err) {
      throw new Error(
        `Failed to read ${curatedEntry.relPath}: ${(err as Error).message}`,
      )
    }

    const entry = generatePersonaManifest(
      curatedEntry.relPath,
      rawContent,
      repoRoot,
    )
    entries.push(entry)

    // Track filename collisions
    const folded = foldIdentity(entry.filename)
    const existing = byFoldedFilename.get(folded) ?? []
    existing.push(curatedEntry.relPath)
    byFoldedFilename.set(folded, existing)
  }

  // Reject filename collisions
  const collisions = [...byFoldedFilename.entries()].filter(
    ([, sources]) => sources.length > 1,
  )
  if (collisions.length > 0) {
    const msg = collisions
      .map(([filename, sources]) => `  "${filename}": ${sources.join(', ')}`)
      .join('\n')
    throw new Error(
      `Filename collision(s) detected in curated persona list:\n${msg}\nUpdate CURATED_PERSONAS to resolve conflicts.`,
    )
  }

  // Reject new critical coupling on any curated persona
  const criticals = entries.filter((e) => e.status === 'excluded-critical')
  if (criticals.length > 0) {
    const msg = criticals
      .map((e) => `  ${e.sourceRelPath}: ${e.reason}`)
      .join('\n')
    throw new Error(
      `Critical compatibility coupling detected in curated personas:\n${msg}\nRemove these personas from CURATED_PERSONAS or fix the coupling.`,
    )
  }

  return entries
}

// ── Drift check (unit-level) ──────────────────────────────────────────────────

/**
 * Compare generated content (from `entries`) against files on disk in `outputDir`.
 *
 * Drift is detected when:
 *   - A file expected by an entry is missing from outputDir
 *   - A file in outputDir has different content than the entry's hash
 *
 * Does not flag extra files not in the manifest (those belong to cleanup, Unit 2).
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
 *
 * The check:
 *   1. Runs generateAll() — fails loudly on new critical coupling or collisions.
 *   2. Compares each expected file against the committed fixture.
 *   3. Checks for unexpected files in FIXTURE_DIR (extra generated files that
 *      are no longer in the curated list).
 *
 * Returns { ok, failures } where failures is an array of human-readable lines
 * naming each stale/missing/extra file. Callers should print failures to stderr
 * and exit(1) when !ok.
 */
export function checkFixtureDrift(
  repoRoot: string,
  fixtureDir: string,
): { ok: boolean; failures: string[] } {
  const failures: string[] = []

  // Step 1: generate all — throws on new critical coupling or collisions
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

  // Step 2: check each expected file
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

  // Step 3: check for extra (unexpected) .md files in fixture dir
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

/** Write committed fixture files from generated entries. Returns { written, upToDate }. */
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

  // Write manifest (content field omitted — content is in the .md files)
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

/** Print a human-readable persona summary to stdout. */
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
    // Source-side fixture drift check — exit 0 if up-to-date, exit 1 with details if not.
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

  // Write mode: generate and write committed fixtures (not a user directory).
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
