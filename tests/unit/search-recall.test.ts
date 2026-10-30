/**
 * Recall floor for the lexical lane (R16), and Checkpoint A.
 *
 * What it measures: a query counts as found when at least one path in its
 * `relevant` list is among the top 5 hits that `runSearch` returns (limit 5,
 * lifecycle resolved) over this repository's real `docs/solutions/`. One
 * aggregate integer floor covers every `lexical_reachable: true` query across
 * both splits. Per-split counts and the recorded grep baseline are printed
 * beside it.
 *
 * CHECKPOINT A RETUNE GRID (fixed before any held-out query was run)
 * ------------------------------------------------------------------
 * Three field-weight tables x body `b` in {0.75, 0.5, 0.9} x `k1` in
 * {1.2, 0.9, 1.6} = 27 cells. Metadata fields keep b = 0, and the tokenizer
 * is not in the grid.
 *
 *   field         starting  flatter  steeper
 *   title            3        2        4
 *   symptoms         3        2        4
 *   tags             2.5      1.75     3.25
 *   applies_when     2        1.5      2.5
 *   module           2        1.5      2.5
 *   component        1.5      1.25     1.75
 *   problem_type     1.5      1.25     1.75
 *   body             1        1        1
 *
 * "flatter" halves, and "steeper" scales by 1.5, each metadata weight's
 * excess over the body weight (w' = 1 + (w - 1) x 0.5 or x 1.5).
 *
 * Rules, fixed up front:
 *   - The grid runs once, on the `tune` split only, over the tune queries
 *     with `lexical_reachable: true`. Score = queries found in the top 5.
 *   - The winner is the best score. Ties resolve to the first cell in
 *     enumeration order (table starting, flatter, steeper; then b 0.75, 0.5,
 *     0.9; then k1 1.2, 0.9, 1.6), which puts the committed defaults first.
 *   - The winner is frozen in `BM25F_PARAMS` (search-lexical.ts).
 *   - Only after the freeze are the held-out queries run, #820 included.
 *   - The floor is the first measured aggregate minus 1.
 *   - If the #820 target is not in the top 5, stop: no retune, and no change
 *     to the query, the labels or the tokenizer.
 *
 * RESULT (added after the single grid run, 2026-10-29; 12 reachable tune
 * queries)
 *   - Every cell with body b = 0.75 or 0.9 scored 11/12, for all three
 *     tables and all three k1 values. Every cell with b = 0.5 scored 10/12.
 *   - Best score 11, tied across 18 cells. The tie went to the first cell in
 *     enumeration order: starting table, b 0.75, k1 1.2. The committed
 *     defaults are frozen unchanged.
 *   - In the winning cell the one tune miss was q18.
 *
 * If corpus growth trips the floor, re-measure on purpose and update it: do
 * not loosen the ranker to make a number pass.
 */

import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { runSearch } from '../../src/lib/search-core.js'
import { loadCorpus } from '../../src/lib/search-corpus.js'
import { tokenize } from '../../src/lib/search-lexical.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

type Split = 'tune' | 'heldout'
type Source = 'issue' | 'paraphrase' | 'symptoms'

interface QueryEntry {
  readonly id: string
  readonly query: string
  readonly relevant: readonly string[]
  readonly split: Split
  readonly lexical_reachable: boolean
  readonly source: Source
  readonly token_overlap?: unknown
}

interface QuerySet {
  readonly queries: readonly QueryEntry[]
}

interface GrepBaseline {
  readonly counts: {
    readonly overall: { readonly found: number; readonly total: number }
    readonly tune: { readonly found: number; readonly total: number }
    readonly heldout: { readonly found: number; readonly total: number }
    readonly lexical_reachable_true: {
      readonly found: number
      readonly total: number
    }
  }
}

const querySet: QuerySet = JSON.parse(
  fs.readFileSync(
    path.join(ROOT_DIR, 'tests/fixtures/search-queries.json'),
    'utf8',
  ),
)
const grepBaseline: GrepBaseline = JSON.parse(
  fs.readFileSync(
    path.join(ROOT_DIR, 'tests/fixtures/search-baseline-grep.json'),
    'utf8',
  ),
)
const queries = querySet.queries
const corpus = loadCorpus(ROOT_DIR)
const byPath = new Map(corpus.documents.map((doc) => [doc.path, doc]))
const ISSUE_820 = 'issue-820-prose-dedup'

function sharedLongToken(entry: QueryEntry): boolean {
  const queryTokens = new Set(
    tokenize(entry.query).filter((t) => t.length >= 3),
  )
  return entry.relevant.some((relevantPath) => {
    const doc = byPath.get(relevantPath)
    if (doc === undefined) return false
    const frontmatter = [
      doc.title,
      doc.symptoms.join(' '),
      doc.tags.join(' '),
      doc.module ?? '',
    ].join(' ')
    return tokenize(frontmatter).some((token) => queryTokens.has(token))
  })
}

describe('query set shape (fails before any ranking)', () => {
  it('holds 15 to 20 uniquely named queries with valid splits and sources', () => {
    expect(queries.length).toBeGreaterThanOrEqual(15)
    expect(queries.length).toBeLessThanOrEqual(20)
    expect(new Set(queries.map((q) => q.id)).size).toBe(queries.length)
    for (const entry of queries) {
      expect(['tune', 'heldout']).toContain(entry.split)
      expect(['issue', 'paraphrase', 'symptoms']).toContain(entry.source)
      expect(entry.query.trim().length).toBeGreaterThan(0)
      expect(entry.relevant.length).toBeGreaterThan(0)
    }
  })

  it('holds 4 to 6 held-out queries and mostly non-symptoms tune sources', () => {
    const heldout = queries.filter((q) => q.split === 'heldout')
    expect(heldout.length).toBeGreaterThanOrEqual(4)
    expect(heldout.length).toBeLessThanOrEqual(6)
    const tune = queries.filter((q) => q.split === 'tune')
    const copied = tune.filter((q) => q.source === 'symptoms')
    expect(copied.length * 2).toBeLessThanOrEqual(tune.length)
  })

  it('labels only real, indexed documents, never a README or _archived/', () => {
    expect(corpus.warnings).toEqual([])
    for (const entry of queries) {
      for (const relevantPath of entry.relevant) {
        expect(relevantPath.startsWith('docs/solutions/')).toBe(true)
        expect(relevantPath.endsWith('.md')).toBe(true)
        expect(relevantPath.toLowerCase().endsWith('readme.md')).toBe(false)
        expect(relevantPath.includes('/_archived/')).toBe(false)
        expect(fs.existsSync(path.join(ROOT_DIR, relevantPath))).toBe(true)
        expect(byPath.has(relevantPath)).toBe(true)
      }
    }
  })

  it('has at least two lexically unreachable queries and checks reachability', () => {
    expect(
      queries.filter((q) => !q.lexical_reachable).length,
    ).toBeGreaterThanOrEqual(2)
    for (const entry of queries.filter((q) => q.lexical_reachable)) {
      expect(sharedLongToken(entry)).toBe(true)
    }
  })

  it('carries the #820 query as held-out, reachable, with its overlap recorded', () => {
    const entry = queries.find((q) => q.id === ISSUE_820)
    expect(entry?.split).toBe('heldout')
    expect(entry?.lexical_reachable).toBe(true)
    expect(entry?.source).toBe('issue')
    expect(entry?.relevant).toContain(
      'docs/solutions/best-practices/a-perfect-measurement-means-a-broken-instrument-2026-08-16.md',
    )
    expect(entry?.token_overlap).toBeDefined()
  })
})

/**
 * First measured aggregate at the frozen parameters (Checkpoint A, 2026-10-29):
 * 15 of 16 reachable queries (tune 11 of 12, held-out 4 of 4), so the floor is
 * 14. Re-measure on purpose if corpus growth trips it.
 */
const RECALL_FLOOR = 14
/** The top-5 cut that defines "found". */
const TOP_N = 5

interface Outcome {
  readonly entry: QueryEntry
  readonly found: boolean
  /** 1-based position of the best relevant hit among the top 20, or undefined. */
  readonly rank: number | undefined
  readonly top: readonly string[]
}

async function measure(entry: QueryEntry): Promise<Outcome> {
  const response = await runSearch(
    { query: entry.query, limit: 20 },
    { startDir: ROOT_DIR },
  )
  if (!response.ok) throw new Error(response.text)
  const top = response.result.hits.map((hit) => hit.document.path)
  const index = top.findIndex((hit) => entry.relevant.includes(hit))
  return {
    entry,
    found: index !== -1 && index < TOP_N,
    rank: index === -1 ? undefined : index + 1,
    top: top.slice(0, TOP_N),
  }
}

function count(outcomes: readonly Outcome[], split?: Split) {
  const reachable = outcomes.filter(
    (o) =>
      o.entry.lexical_reachable &&
      (split === undefined || o.entry.split === split),
  )
  return {
    found: reachable.filter((o) => o.found).length,
    total: reachable.length,
  }
}

describe('lexical recall over the live docs/solutions', () => {
  it('meets the aggregate floor, finds #820 in the top 5, and reports per-split counts', async () => {
    const outcomes = await Promise.all(queries.map(measure))

    const aggregate = count(outcomes)
    const tune = count(outcomes, 'tune')
    const heldout = count(outcomes, 'heldout')
    const grep = grepBaseline.counts
    console.info(
      [
        `lexical recall (top ${TOP_N}, lexical_reachable queries): aggregate ${aggregate.found}/${aggregate.total}, tune ${tune.found}/${tune.total}, held-out ${heldout.found}/${heldout.total}`,
        `grep baseline (same metric):                    aggregate ${grep.lexical_reachable_true.found}/${grep.lexical_reachable_true.total} reachable, overall ${grep.overall.found}/${grep.overall.total}, tune ${grep.tune.found}/${grep.tune.total}, held-out ${grep.heldout.found}/${grep.heldout.total}`,
        `floor: ${RECALL_FLOOR}`,
      ].join('\n'),
    )

    expect(aggregate.total).toBe(
      queries.filter((q) => q.lexical_reachable).length,
    )
    expect(aggregate.found).toBeGreaterThanOrEqual(RECALL_FLOOR)

    const issue820 = outcomes.find((o) => o.entry.id === ISSUE_820)
    expect(issue820?.rank).toBeDefined()
    expect(issue820?.found).toBe(true)
  })
})
