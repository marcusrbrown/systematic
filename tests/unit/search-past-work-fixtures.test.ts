import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// Shape and consistency checks for the past-work labels and the two recorded
// baselines. Nothing here runs a ranker. The labels came first and the
// baselines were scored against them with the one function below.

const ROOT = path.resolve(import.meta.dirname, '../..')
const readJson = (rel: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

const KINDS = ['solution', 'plan', 'brainstorm', 'ideation'] as const
type Kind = (typeof KINDS)[number]

const KIND_DIR: Record<Kind, string> = {
  solution: 'docs/solutions/',
  plan: 'docs/plans/',
  brainstorm: 'docs/brainstorms/',
  ideation: 'docs/ideation/',
}

const COVERAGE_TAGS = [
  'rejected-or-deferred-brainstorm',
  'completed-plan',
  'ideation',
  'superseded-chain',
  'superseded-plan',
  'mixed-kind',
  'solution',
] as const

const TOP_K = 5

interface Relevant {
  path: string
  kind: Kind
}

interface LabelledQuery {
  id: string
  query: string
  target_kind: Kind | 'any'
  relevant: Relevant[]
  source: 'paraphrase' | 'title' | 'body'
  requires_local?: true
  coverage: string[]
}

interface Counts {
  found: number
  total: number
}

interface BaselineQuery {
  id: string
  returned: string[]
  hit: boolean
}

interface Baseline {
  queries: BaselineQuery[]
  counts: { overall: Counts }
  repo_ref: string
  date: string
  model: string
  method: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKind(value: unknown): value is Kind {
  return KINDS.some((kind) => kind === value)
}

function parseRelevant(id: string, raw: unknown): Relevant {
  if (!isRecord(raw) || typeof raw.path !== 'string' || !isKind(raw.kind)) {
    throw new Error(`${id}: bad relevant entry`)
  }
  return { path: raw.path, kind: raw.kind }
}

function parseQuery(entry: unknown): LabelledQuery {
  if (!isRecord(entry)) throw new Error('query entry is not an object')
  const { id, query, target_kind, relevant, source, coverage } = entry
  if (typeof id !== 'string' || typeof query !== 'string') {
    throw new Error('query entry needs a string id and query')
  }
  if (target_kind !== 'any' && !isKind(target_kind)) {
    throw new Error(`${id}: unknown target_kind`)
  }
  if (!Array.isArray(relevant) || !Array.isArray(coverage)) {
    throw new Error(`${id}: relevant and coverage must be lists`)
  }
  if (source !== 'paraphrase' && source !== 'title' && source !== 'body') {
    throw new Error(`${id}: unknown source`)
  }
  return {
    id,
    query,
    target_kind,
    source,
    coverage: coverage.map(String),
    requires_local: entry.requires_local === true ? true : undefined,
    relevant: relevant.map((r: unknown) => parseRelevant(id, r)),
  }
}

function parseQueries(raw: unknown): LabelledQuery[] {
  if (!isRecord(raw) || !Array.isArray(raw.queries)) {
    throw new Error('queries fixture has no queries array')
  }
  return raw.queries.map(parseQuery)
}

function parseBaseline(raw: unknown, key: 'a' | 'b'): Baseline {
  if (!isRecord(raw) || !isRecord(raw[key])) {
    throw new Error(`baseline ${key} missing`)
  }
  const section = raw[key]
  const { queries, counts, repo_ref, date, model, method } = section
  if (
    !Array.isArray(queries) ||
    !isRecord(counts) ||
    !isRecord(counts.overall)
  ) {
    throw new Error(`baseline ${key} is malformed`)
  }
  if (
    typeof repo_ref !== 'string' ||
    typeof date !== 'string' ||
    typeof model !== 'string' ||
    typeof method !== 'string'
  ) {
    throw new Error(`baseline ${key} lacks method, ref, date or model`)
  }
  return {
    repo_ref,
    date,
    model,
    method,
    counts: {
      overall: {
        found: Number(counts.overall.found),
        total: Number(counts.overall.total),
      },
    },
    queries: queries.map((q: unknown) => {
      if (
        !isRecord(q) ||
        typeof q.id !== 'string' ||
        !Array.isArray(q.returned)
      ) {
        throw new Error(`baseline ${key} has a malformed query entry`)
      }
      return {
        id: q.id,
        returned: q.returned.map(String),
        hit: q.hit === true,
      }
    }),
  }
}

/** The one scoring function: found when any relevant path is in the first five returned. */
function isFound(
  relevant: readonly Relevant[],
  returned: readonly string[],
): boolean {
  const wanted = new Set(relevant.map((r) => r.path))
  return returned.slice(0, TOP_K).some((p) => wanted.has(p))
}

const baselineFile = readJson('tests/fixtures/search-past-work-baseline.json')
const queries = parseQueries(
  readJson('tests/fixtures/search-past-work-queries.json'),
)
const baselineA = parseBaseline(baselineFile, 'a')
const baselineB = parseBaseline(baselineFile, 'b')

const tagged = (tag: string) => queries.filter((q) => q.coverage.includes(tag))
const kindsOf = (q: LabelledQuery) => new Set(q.relevant.map((r) => r.kind))

describe('past-work query labels', () => {
  test('there are 10 to 16 queries with unique ids and unique query text', () => {
    expect(queries.length).toBeGreaterThanOrEqual(10)
    expect(queries.length).toBeLessThanOrEqual(16)
    expect(new Set(queries.map((q) => q.id)).size).toBe(queries.length)
    expect(new Set(queries.map((q) => q.query)).size).toBe(queries.length)
  })

  test('every query has a non-empty relevant list whose entries match their directory', () => {
    for (const q of queries) {
      expect(q.relevant.length).toBeGreaterThan(0)
      for (const r of q.relevant) {
        expect(r.path.startsWith(KIND_DIR[r.kind])).toBe(true)
        expect(r.path.endsWith('.md')).toBe(true)
        expect(r.path.includes('..')).toBe(false)
      }
      expect(new Set(q.relevant.map((r) => r.path)).size).toBe(
        q.relevant.length,
      )
    }
  })

  test('a kind-restricted query labels only paths of that kind, and its targets are reachable', () => {
    for (const q of queries) {
      if (q.target_kind === 'any') continue
      expect(q.relevant.every((r) => r.kind === q.target_kind)).toBe(true)
    }
  })

  test('every relevant path exists, except brainstorms that live only in the primary checkout', () => {
    for (const q of queries) {
      for (const r of q.relevant) {
        if (r.kind === 'brainstorm') {
          // Untracked here, so a clone without it skips only this check.
          if (q.requires_local) continue
          expect(fs.existsSync(path.join(ROOT, r.path))).toBe(true)
          continue
        }
        expect(fs.existsSync(path.join(ROOT, r.path))).toBe(true)
      }
    }
  })

  test('requires_local is set exactly when a relevant path is a brainstorm', () => {
    for (const q of queries) {
      const hasBrainstorm = q.relevant.some((r) => r.kind === 'brainstorm')
      expect(q.requires_local === true).toBe(hasBrainstorm)
    }
  })

  test('coverage tags come from the known vocabulary and match the labelled kinds', () => {
    // Each tag implies something about the kinds the query labels.
    const needs: Record<string, (kinds: Set<Kind>) => boolean> = {
      'mixed-kind': (kinds) => kinds.size > 1,
      ideation: (kinds) => kinds.has('ideation'),
      solution: (kinds) => kinds.has('solution'),
      'completed-plan': (kinds) => kinds.has('plan'),
      'superseded-plan': (kinds) => kinds.has('plan'),
      'rejected-or-deferred-brainstorm': (kinds) => kinds.has('brainstorm'),
      'superseded-chain': () => true,
    }
    expect(Object.keys(needs).sort()).toEqual([...COVERAGE_TAGS].sort())
    for (const q of queries) {
      expect(q.coverage.length).toBeGreaterThan(0)
      for (const tag of q.coverage) {
        const check = needs[tag]
        expect(check).toBeDefined()
        expect(check?.(kindsOf(q))).toBe(true)
      }
    }
  })

  test('the coverage mix holds', () => {
    expect(
      tagged('rejected-or-deferred-brainstorm').length,
    ).toBeGreaterThanOrEqual(2)
    expect(tagged('completed-plan').length).toBeGreaterThanOrEqual(2)
    expect(tagged('ideation').length).toBeGreaterThanOrEqual(1)
    expect(tagged('superseded-chain').length).toBeGreaterThanOrEqual(1)
    expect(tagged('mixed-kind').length).toBeGreaterThanOrEqual(3)
  })

  test('the set includes low-overlap queries, not only title echoes', () => {
    const lowOverlap = queries.filter((q) => q.source !== 'title')
    expect(lowOverlap.length).toBeGreaterThanOrEqual(3)
  })
})

describe('past-work baselines', () => {
  test('each baseline records its method, repo ref, date and model', () => {
    for (const baseline of [baselineA, baselineB]) {
      expect(baseline.method.length).toBeGreaterThan(0)
      expect(baseline.repo_ref).toMatch(/^[0-9a-f]{7,}/)
      expect(baseline.date).toMatch(/^\d{4}-\d{2}-\d{2}/)
      expect(baseline.model.length).toBeGreaterThan(0)
    }
  })

  test('baseline A records its as-of date, window and the scans that do not exist', () => {
    const raw = baselineFile
    if (!isRecord(raw) || !isRecord(raw.a))
      throw new Error('baseline a missing')
    expect(raw.a.as_of).toBe('2026-10-30')
    expect(raw.a.window_days).toBe(30)
    const scans = raw.a.scans
    if (!Array.isArray(scans)) throw new Error('baseline a has no scans list')
    const noScan = scans.filter(
      (scan: unknown) => isRecord(scan) && scan.status === 'no scan',
    )
    expect(noScan.length).toBeGreaterThanOrEqual(2)
  })

  test('baseline B records the deviations of its single-shot run', () => {
    const raw = baselineFile
    if (!isRecord(raw) || !isRecord(raw.b))
      throw new Error('baseline b missing')
    const deviations = raw.b.deviations
    expect(Array.isArray(deviations) && deviations.length > 0).toBe(true)
  })

  test('both baselines answer every labelled query exactly once, in order', () => {
    const ids = queries.map((q) => q.id)
    expect(baselineA.queries.map((q) => q.id)).toEqual(ids)
    expect(baselineB.queries.map((q) => q.id)).toEqual(ids)
  })

  test('re-scoring each baseline with one function reproduces the stored hits and counts', () => {
    for (const baseline of [baselineA, baselineB]) {
      let found = 0
      for (const result of baseline.queries) {
        const labelled = queries.find((q) => q.id === result.id)
        if (!labelled) throw new Error(`no label for ${result.id}`)
        const scored = isFound(labelled.relevant, result.returned)
        expect(scored).toBe(result.hit)
        if (scored) found++
      }
      expect(baseline.counts.overall).toEqual({
        found,
        total: baseline.queries.length,
      })
    }
  })

  test('the scoring function ignores a relevant path ranked below the top five', () => {
    const relevant: Relevant[] = [{ path: 'docs/plans/x.md', kind: 'plan' }]
    const filler = ['a', 'b', 'c', 'd', 'e']

    expect(isFound(relevant, [...filler, 'docs/plans/x.md'])).toBe(false)
    expect(isFound(relevant, ['a', 'b', 'c', 'd', 'docs/plans/x.md'])).toBe(
      true,
    )
    expect(isFound(relevant, [])).toBe(false)
  })
})
