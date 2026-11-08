/**
 * Checks for the committed part of the `ce:connect` evaluation: the label file,
 * the frozen-file digest and the leak scan. Pure functions, so tests can feed them
 * both the committed files and deliberately broken copies.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }

/** The skill, helper bundle and agent that a registered run exercises. A change to any of them is a new registered run. */
export const FROZEN_PATHS: readonly string[] = [
  'skills/ce-connect/SKILL.md',
  'skills/ce-connect/references/candidate-contract.md',
  'skills/ce-connect/references/headless-and-outcomes.md',
  'skills/ce-connect/scripts/connect.mjs',
  'agents/research/connections-researcher.md',
]

const THRESHOLDS = {
  precisionMin: 0.7,
  seededFoundRuns: 3,
  repetitions: 3,
  regressionRecall: { found: 4, of: 4 },
} as const

const GROUPS = [
  { key: 'regression', prefix: 'r', count: 4, labels: ['worth-promoting'] },
  { key: 'seeded', prefix: 's', count: undefined, labels: ['must-find'] },
  {
    key: 'controls',
    prefix: 'c',
    count: undefined,
    labels: ['must-not-report'],
  },
] as const

const FRESH_STATUSES = ['awaiting-labeler', 'labeled'] as const
const FRESH_LABELS = ['worth-promoting', 'real-not-worth'] as const

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'thresholds',
  'regression',
  'seeded',
  'controls',
  'fresh',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function opaqueId(prefix: string): RegExp {
  return new RegExp(`^${prefix}-\\d{2}$`)
}

function unexpectedKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: unexpected key ${key}`)
}

function validateThresholds(value: unknown): string[] {
  if (!isRecord(value)) return ['thresholds: missing']
  const problems = unexpectedKeys('thresholds', value, Object.keys(THRESHOLDS))
  for (const field of [
    'precisionMin',
    'seededFoundRuns',
    'repetitions',
  ] as const) {
    if (value[field] !== THRESHOLDS[field]) {
      problems.push(
        `threshold ${field} must be ${THRESHOLDS[field]}, found ${JSON.stringify(value[field])}`,
      )
    }
  }
  const recall = value.regressionRecall
  const want = THRESHOLDS.regressionRecall
  if (
    !isRecord(recall) ||
    recall.found !== want.found ||
    recall.of !== want.of
  ) {
    problems.push(
      `threshold regressionRecall must be ${want.found} of ${want.of}, found ${JSON.stringify(recall)}`,
    )
  }
  return problems
}

function validateEntries(
  group: (typeof GROUPS)[number],
  value: unknown,
  seen: Set<string>,
): string[] {
  if (!Array.isArray(value)) return [`${group.key}: missing list`]
  const problems: string[] = []
  if (group.count !== undefined && value.length !== group.count) {
    problems.push(
      `${group.key}: expected ${group.count} entries, found ${value.length}`,
    )
  }
  if (group.count === undefined && value.length === 0) {
    problems.push(`${group.key}: needs at least one entry`)
  }
  value.forEach((entry, index) => {
    const where = `${group.key}[${index}]`
    if (!isRecord(entry)) {
      problems.push(`${where}: not an object`)
      return
    }
    problems.push(...unexpectedKeys(where, entry, ['id', 'label']))
    const id = entry.id
    if (typeof id !== 'string' || !opaqueId(group.prefix).test(id)) {
      problems.push(
        `${where}: id ${JSON.stringify(id)} is not opaque (expected ${group.prefix}-NN)`,
      )
    } else if (seen.has(id)) {
      problems.push(`${where}: duplicate id ${id}`)
    } else {
      seen.add(id)
    }
    const label = entry.label
    if (typeof label !== 'string') {
      problems.push(`${where}: label missing`)
    } else if (!(group.labels as readonly string[]).includes(label)) {
      problems.push(
        `${where}: label ${JSON.stringify(label)} is not one of ${group.labels.join(', ')}`,
      )
    }
  })
  return problems
}

function validateFresh(value: unknown, seen: Set<string>): string[] {
  if (!isRecord(value)) return ['fresh: missing']
  const problems = unexpectedKeys('fresh', value, ['status', 'labels'])
  const status = value.status
  if (!(FRESH_STATUSES as readonly unknown[]).includes(status)) {
    problems.push(`fresh: status must be one of ${FRESH_STATUSES.join(', ')}`)
  }
  const list = value.labels
  if (!Array.isArray(list)) return [...problems, 'fresh: labels missing']
  if (status === 'awaiting-labeler' && list.length > 0) {
    problems.push(
      'fresh: labels must be empty while the set awaits its labeler',
    )
  }
  list.forEach((entry, index) => {
    const where = `fresh.labels[${index}]`
    if (!isRecord(entry)) {
      problems.push(`${where}: not an object`)
      return
    }
    problems.push(...unexpectedKeys(where, entry, ['id', 'label']))
    const id = entry.id
    if (typeof id !== 'string' || !opaqueId('f').test(id)) {
      problems.push(
        `${where}: id ${JSON.stringify(id)} is not opaque (expected f-NN)`,
      )
    } else if (seen.has(id)) {
      problems.push(`${where}: duplicate id ${id}`)
    } else {
      seen.add(id)
    }
    if (
      typeof entry.label !== 'string' ||
      !(FRESH_LABELS as readonly string[]).includes(entry.label)
    ) {
      problems.push(
        `${where}: label must be one of ${FRESH_LABELS.join(', ')} (a false candidate is not a label)`,
      )
    }
  })
  return problems
}

/** Returns every problem found in a label file; an empty list means it is well formed. */
export function validateLabels(value: Json): string[] {
  if (!isRecord(value)) return ['labels: not an object']
  const problems = unexpectedKeys('labels', value, TOP_LEVEL_KEYS)
  if (value.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  problems.push(...validateThresholds(value.thresholds))
  const seen = new Set<string>()
  for (const group of GROUPS) {
    problems.push(...validateEntries(group, value[group.key], seen))
  }
  problems.push(...validateFresh(value.fresh, seen))
  return problems
}

/** One digest over the frozen files: sha256 of `path NUL file-sha256 LF` lines in path order. */
export function frozenDigest(root: string, paths: readonly string[]): string {
  const lines = [...new Set(paths)].sort().map((rel) => {
    const content = fs.readFileSync(path.join(root, rel))
    const fileHash = createHash('sha256').update(content).digest('hex')
    return `${rel}\0${fileHash}\n`
  })
  return createHash('sha256').update(lines.join('')).digest('hex')
}

interface LeakPattern {
  readonly label: string
  readonly pattern: RegExp
}

/** Shapes that never belong in a committed evaluation file: a home path, a scratch path, an org slug. */
export const BUILTIN_LEAK_PATTERNS: readonly LeakPattern[] = [
  { label: 'home path', pattern: /\/Users\/|\/home\/[a-z]/ },
  { label: 'scratch path', pattern: /systematic-scratch/ },
  { label: 'org slug', pattern: /\bfro-bot\// },
]

/**
 * Scans file contents for private terms (case-insensitive, literal) and, unless
 * switched off, the built-in shapes. Returns `file: term` for each hit.
 */
export function findLeaks(
  files: Readonly<Record<string, string>>,
  terms: readonly string[],
  options: { readonly builtin?: boolean } = {},
): string[] {
  const hits: string[] = []
  const wanted = terms.filter((term) => term !== '')
  for (const [file, content] of Object.entries(files)) {
    const lower = content.toLowerCase()
    for (const term of wanted) {
      if (lower.includes(term.toLowerCase())) hits.push(`${file}: ${term}`)
    }
    if (options.builtin === false) continue
    for (const { label, pattern } of BUILTIN_LEAK_PATTERNS) {
      if (pattern.test(content)) hits.push(`${file}: ${label}`)
    }
  }
  return hits
}

/** Reads one private term per line. An unset or unreadable file means no terms. */
export function readPrivateTerms(file: string | undefined): string[] {
  if (file === undefined || file === '') return []
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}
