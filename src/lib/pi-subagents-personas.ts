/**
 * Pure persona generation logic for pi-subagents interop.
 *
 * Contains the curated persona list, compatibility screening, content
 * generation, and generateAll(). Importable from both src/ and scripts/.
 * No filesystem writes; no CLI entrypoint.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'

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

// ── Curated persona list ──────────────────────────────────────────────────────

/**
 * The authoritative curated-include list with per-persona compatibility
 * rationale. Only personas in this list are candidates for export.
 *
 * Exclusion rationale (not in list):
 *   - agents/workflow/systematic-implementer.md — CRITICAL: dispatched-by-parent assumption.
 *   - agents/design/design-iterator.md — CRITICAL: requires agent-browser + skill load.
 *   - agents/review/agent-native-reviewer.md — CRITICAL: Systematic/OpenCode-specific context.
 *   - agents/review/project-standards-reviewer.md — CRITICAL: requires orchestrator <standards-paths>.
 *   - agents/review/kieran-typescript-reviewer.md — WARNING: excluded by plan recommendation.
 *   - agents/research/slack-researcher.md — CRITICAL: requires Slack MCP environment.
 *   - agents/research/learnings-researcher.md — CRITICAL: references Systematic skill paths.
 *   - agents/workflow/pr-comment-resolver.md — WARNING: "Spawned by the resolve-pr-feedback skill".
 */
export interface CuratedPersonaEntry {
  relPath: string
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
 * Returns empty string if no safe characters remain — callers must reject
 * empty to avoid producing `systematic-.md`.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[/\\]/g, '')
    .replace(/\./g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── Identity fold ─────────────────────────────────────────────────────────────

function foldIdentity(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

// ── Compatibility screening ───────────────────────────────────────────────────

const CRITICAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /dispatched by a parent/i,
    reason:
      'References parent-dispatch assumption ("dispatched by a parent") — this persona is designed to be orchestrated by Systematic.',
  },
  {
    pattern: /report(?:ing)? back to the orchestrator/i,
    reason:
      "References orchestrator-report assumption — this persona is designed to operate within Systematic's orchestration loop.",
  },
  {
    pattern: /\bload\s+(?:the\s+)?systematic:/i,
    reason:
      'Contains explicit Systematic skill load directive ("Load systematic:...") — requires Systematic skill loading infrastructure.',
  },
  {
    pattern: /load\s+`systematic:/i,
    reason:
      'Contains explicit Systematic skill load directive with backtick form — requires Systematic skill loading infrastructure.',
  },
  {
    pattern: /\.\.(\/|\\)\.\.(?:\/|\\)skills\//,
    reason:
      'Directly references Systematic internal skill paths (../../skills/...) — not portable outside Systematic.',
  },
]

const WARNING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bagent-browser\s+(?:CLI|skill)\b/i,
    reason:
      'References agent-browser CLI/skill as an optional tool hint. Behavior may differ if agent-browser is not available, but persona remains operable without it.',
  },
  {
    pattern: /use\s+(?:the\s+)?agent-browser\s+skill/i,
    reason:
      'Suggests using the agent-browser skill. Persona operates without it but visual verification steps would be skipped.',
  },
]

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

// ── Content generation ────────────────────────────────────────────────────────

export function generatePersonaContent(
  sourceRef: string,
  rawContent: string,
): string | null {
  const { data, body, hadFrontmatter } =
    parseFrontmatter<Record<string, unknown>>(rawContent)

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

  const sanitized = sanitizeName(trimmedName)
  if (sanitized === '') {
    throw new Error(
      `Persona "${sourceRef}" name "${trimmedName}" sanitizes to an empty string — cannot produce a valid filename. Rename the persona to use alphanumeric characters.`,
    )
  }

  const compat = classifyCompatibility(rawContent)
  if (compat.severity === 'critical') return null

  const description =
    typeof data.description === 'string' ? data.description : undefined
  const emittedFrontmatter: Record<string, unknown> = {}
  if (description !== undefined && description.trim() !== '') {
    emittedFrontmatter.description = description
  }

  let frontmatterBlock: string
  if (Object.keys(emittedFrontmatter).length === 0) {
    frontmatterBlock = '---\n---'
  } else {
    const lines = Object.entries(emittedFrontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n')
    frontmatterBlock = `---\n${lines}\n---`
  }

  const trimmedBody = body.replace(/^\n+/, '')
  return `${frontmatterBlock}\n\n${trimmedBody}`
}

// ── Manifest entry generation ─────────────────────────────────────────────────

export function generatePersonaManifest(
  sourceRelPath: string,
  rawContent: string,
  _repoRoot: string,
): ManifestEntry {
  const { data } = parseFrontmatter<Record<string, unknown>>(rawContent)
  const rawName = data.name

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

  const content = generatePersonaContent(sourceRelPath, rawContent)
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

// ── Generate all ──────────────────────────────────────────────────────────────

/**
 * Generate all curated personas from repoRoot/agents/.
 * Throws on collision, new critical coupling, or read errors.
 * Pure — no writes.
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

    const folded = foldIdentity(entry.filename)
    const existing = byFoldedFilename.get(folded) ?? []
    existing.push(curatedEntry.relPath)
    byFoldedFilename.set(folded, existing)
  }

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
