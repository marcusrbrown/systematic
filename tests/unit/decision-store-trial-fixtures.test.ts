import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// Needs keep flags only; every cell count is recomputed from them. Agreement
// is a recorded header value (it needs document-level labels), not recomputed.

const DIR = path.resolve(import.meta.dirname, '../fixtures')
const TEXT = fs.readFileSync(
  `${DIR}/decision-store-trial-evidence.json`,
  'utf8',
)
const POOLS = ['sp', 'ag', 'gh', 'in'] as const
type Pool = (typeof POOLS)[number]
const STORES: Record<Pool, string[]> = {
  sp: ['deciduous'],
  ag: ['legacy', 'agent-wiki', 'github-wiki'],
  gh: ['github-wiki'],
  in: ['runbook'],
}
const CELLS = [
  { cell: 1, pool: 'sp', store: 'deciduous' },
  { cell: 2, pool: 'ag', store: 'legacy' },
  { cell: 3, pool: 'ag', store: 'agent-wiki' },
  { cell: 4, pool: 'ag', store: 'github-wiki' },
  { cell: 5, pool: 'gh', store: 'github-wiki' },
  { cell: 6, pool: 'in', store: 'runbook' },
] as const
const FIRST: Record<string, string> = {
  deciduous: '2026-09',
  legacy: '2026-01',
  'agent-wiki': '2026-04',
  'github-wiki': '2026-04',
  runbook: '2026-05',
}
const SOURCES = ['pr-or-issue-title', 'body-sentence', 'dispatch-topic']
const ID = { run1: /^n-(sp|ag|gh|in)-\d{3}$/, a4: /^a-(sp|ag|gh|in)-\d{3}$/ }
const MAX = { run1: 30, a4: 10 }
const [FLOOR, THIN] = [5, 15]
const SESSION = /\bses_[A-Za-z0-9]{12,}\b/
const THREAD = /(^|[^\w&])#\d{1,6}\b|\/(issues|pull)\/\d+/
const BANNED = ['query', 'sentence', 'need', 'text', 'prompt', 'title', 'body']

type Run = 'run1' | 'a4'
type Obj = Record<string, unknown>
type Flags = { store_answers: boolean; store_helps: boolean }
interface Entry {
  id: string
  pool: string
  source: string
  month: string
  sys: { sys_answers: boolean; sys_helps: boolean }
  stores?: Record<string, Flags>
  outcome: string
}

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const fixture: unknown = JSON.parse(TEXT)
const at = (...keys: string[]) =>
  keys.reduce<unknown>((c, k) => (isObj(c) ? c[k] : undefined), fixture)
const rawList = (run: Run) => at(run, 'entries') as unknown[]
const entriesOf = (run: Run) => rawList(run) as Entry[]
const inPool = (l: Entry[], pool: string) => l.filter((e) => e.pool === pool)
const hasSys = (e: Entry) => e.sys.sys_answers || e.sys.sys_helps
const nStores = (e: Entry) => Object.keys(e.stores ?? {}).length
const OUTCOME = ['nothing', 'store-only', 'systematic-only', 'both']
const outcomeOf = (e: Entry) =>
  OUTCOME[(hasSys(e) ? 2 : 0) + (nStores(e) > 0 ? 1 : 0)]
const keysOf = (o: unknown) =>
  JSON.stringify(Object.keys(isObj(o) ? o : {}).sort())

/** Problems with one raw entry: documented keys only, flag objects of the documented shape. */
function keyProblems(e: unknown): string[] {
  if (!isObj(e)) return ['not a record']
  const ok = ['id', 'month', 'outcome', 'pool', 'source', 'stores', 'sys']
  const out = Object.keys(e).filter((k) => !ok.includes(k))
  if (keysOf(e.sys) !== '["sys_answers","sys_helps"]') out.push('sys')
  for (const f of Object.values(isObj(e.stores) ? e.stores : {}))
    if (keysOf(f) !== '["store_answers","store_helps"]') out.push('stores')
  return out
}

/** Problems with one entry: id, enums, stores in the pool, outcome against the flags. */
function entryProblems(e: Entry, pool: Pool, run: Run): string[] {
  const p = keyProblems(e)
  if (!ID[run].test(e.id) || e.id.split('-')[1] !== pool) p.push('id')
  if (e.pool !== pool || !/^\d{4}-(0[1-9]|1[0-2])$/.test(e.month))
    p.push('pool')
  const dispatch = run === 'run1' && e.source === 'dispatch-topic'
  if (!SOURCES.includes(e.source) || dispatch) p.push('source')
  for (const [store, f] of Object.entries(e.stores ?? {})) {
    if (!STORES[pool].includes(store)) p.push(`${store} not in ${pool}`)
    if (!f.store_answers && !f.store_helps) p.push(`${store} empty`)
  }
  if (e.outcome !== outcomeOf(e)) p.push('outcome')
  return p
}

/** True when the second labeler's gains and losses would cross the floor. */
function borderline(count: number, gains: number, losses: number): boolean {
  const full = count + gains - losses
  return count < FLOOR
    ? full >= FLOOR || count + gains >= FLOOR
    : full < FLOOR || count - losses < FLOOR
}
const swaps = at('header', 'recorded', 'swap', 'run1') as Obj[]

/** Every cell count, flag and store verdict, recomputed from the per-need flags. */
function derive(run: Run, list: Entry[]) {
  const cells = CELLS.map((c): Obj & { cell: number; n: number } => {
    const all = inPool(list, c.pool)
    const direct = (e: Entry) => e.stores?.[c.store]?.store_answers === true
    const inc = (e: Entry) => direct(e) && !e.sys.sys_answers
    const excl = (e: Entry) => c.store in (e.stores ?? {}) && !hasSys(e)
    if (run === 'a4') {
      const es = all.filter((e) => e.month >= (FIRST[c.store] ?? ''))
      const n = (f: (e: Entry) => boolean) => es.filter(f).length
      return {
        ...c,
        n: es.length,
        direct: n(direct),
        incremental: n(inc),
        exclusive: n(excl),
      }
    }
    const count = all.filter(excl).length
    const n = all.length
    return {
      ...c,
      n,
      count,
      answers_only: all.filter(inc).length,
      qualifies: count >= FLOOR,
      thin: n < THIN,
    }
  })
  const pools = POOLS.map((p) => [p, inPool(list, p).length] as const)
  const by_pool = Object.fromEntries(
    pools.map(([p, n]) => [p, { n, thin: n < THIN }]),
  )
  if (run === 'a4') return { by_pool, cells }
  const stores = [...new Set(CELLS.map((c) => c.store))].map((store) => {
    const mine = cells.filter((c) => c.store === store)
    const sw = (cell: number) => swaps.find((s) => s.cell === cell) ?? {}
    return {
      store,
      qualifies: mine.some((c) => c.qualifies === true),
      untestable: mine.every((c) => c.n < FLOOR),
      borderline: mine.some((c) =>
        borderline(
          Number(c.count),
          Number(sw(c.cell).gains),
          Number(sw(c.cell).losses),
        ),
      ),
    }
  })
  return { by_pool, cells, stores }
}

/** Banned field names, over-long values, session ids and thread numbers anywhere in a value. */
function rawTextProblems(v: unknown, key = ''): string[] {
  const out = BANNED.includes(key) ? [`field ${key}`] : []
  if (typeof v === 'string') {
    if (v.length > 160) out.push('long value')
    if (SESSION.test(v)) out.push('session id')
    if (THREAD.test(v)) out.push('thread number')
  }
  const kids = Array.isArray(v)
    ? v.map((x) => [key, x])
    : isObj(v)
      ? Object.entries(v)
      : []
  return [
    ...new Set([
      ...out,
      ...kids.flatMap(([k, x]) => rawTextProblems(x, String(k))),
    ]),
  ]
}

const sys = (a: boolean, h: boolean) => ({ sys_answers: a, sys_helps: h })
const fl = (a: boolean, h: boolean): Flags => ({
  store_answers: a,
  store_helps: h,
})
const E = (over: Partial<Entry> = {}): Entry => ({
  id: 'n-ag-001',
  pool: 'ag',
  source: 'pr-or-issue-title',
  month: '2026-01',
  sys: sys(true, false),
  stores: { legacy: fl(true, false) },
  outcome: 'both',
  ...over,
})
const wiki = (pool: Pool, i: number) =>
  E({
    id: `n-${pool}-00${i}`,
    pool,
    sys: sys(false, false),
    stores: { 'github-wiki': fl(true, false) },
    outcome: 'store-only',
  })

describe('shape', () => {
  test('header, sections and entries pass: opaque unique ids, 0 to 30 per pool', () => {
    expect(at('header', 'ci_reproducible')).toBe(false)
    expect(at('header', 'cells')).toEqual(CELLS.map((c) => ({ ...c })))
    expect(at('header', 'stop2', 'derived_flags_overridden')).toBe(false)
    expect(at('a4', 'protocol_failure', 'recorded')).toBe(true)
    for (const p of POOLS) {
      const pool = at('header', 'pools', p) as Obj
      expect(pool.stores).toEqual(['systematic', ...STORES[p]])
      for (const ref of Object.values(pool.refs as Obj))
        expect(String(ref)).toMatch(/^[0-9a-f]{40}$/)
    }
    for (const run of ['run1', 'a4'] as const) {
      const list = entriesOf(run)
      expect(new Set(list.map((e) => e.id)).size).toBe(list.length)
      for (const pool of POOLS) {
        expect(inPool(list, pool).length).toBeLessThanOrEqual(MAX[run])
        for (const e of inPool(list, pool))
          expect(entryProblems(e, pool, run)).toEqual([])
      }
    }
  })

  test('error path: a bad id, pool, store, flag, outcome or stray key fails', () => {
    const bad = (e: Entry, run: Run = 'run1') =>
      entryProblems(e, 'ag', run).length > 0
    expect([
      bad(E()),
      bad(E({ outcome: 'store-only' })),
      bad(E({ outcome: 'nothing' })),
    ]).toEqual([false, true, true])
    expect(bad(E({ stores: { runbook: fl(true, false) } }))).toBe(true)
    expect(bad(E({ stores: { legacy: fl(false, false) } }))).toBe(true)
    expect(bad(E({ id: 'n-gh-001' }))).toBe(true)
    expect(bad(E({ source: 'dispatch-topic' }))).toBe(true)
    expect(bad(E({ id: 'a-ag-001', source: 'dispatch-topic' }), 'a4')).toBe(
      false,
    )
    expect(keyProblems({ ...E(), sentence: 'x' })).toEqual(['sentence'])
  })
})

describe('derived totals', () => {
  test('every recorded total equals the value derived from the flags, in both runs', () => {
    expect(at('run1', 'totals')).toEqual(derive('run1', entriesOf('run1')))
    expect(at('a4', 'totals')).toEqual(derive('a4', entriesOf('a4')))
  })

  test('no store is borderline or untestable, so there is no decisions block', () => {
    const stores = derive('run1', entriesOf('run1')).stores ?? []
    expect(stores.some((s) => s.borderline || s.untestable)).toBe(false)
    expect('decisions' in (at('run1') as Obj)).toBe(false)
    expect([borderline(5, 0, 1), borderline(5, 1, 1)]).toEqual([true, true])
    expect([
      borderline(4, 1, 0),
      borderline(4, 1, 1),
      borderline(1, 2, 1),
    ]).toEqual([true, true, false])
  })

  test('the .github wiki has two cells, never summed; an empty pool has n 0', () => {
    const build = (a: number, g: number) => [
      ...Array.from({ length: a }, (_, i) => wiki('ag', i)),
      ...Array.from({ length: g }, (_, i) => wiki('gh', i)),
    ]
    const q = (l: Entry[]) =>
      derive('run1', l).stores?.find((s) => s.store === 'github-wiki')
        ?.qualifies
    expect([q(build(3, 3)), q(build(2, 6))]).toEqual([false, true])
    expect(derive('run1', []).cells.map((c) => c.n)).toEqual([0, 0, 0, 0, 0, 0])
  })

  test('tampering makes the result differ; a helping doc cancels exclusive, not incremental', () => {
    const real = derive('run1', entriesOf('run1'))
    expect({ ...real, cells: [{ ...real.cells[0], count: 9 }] }).not.toEqual(
      real,
    )
    const list = entriesOf('run1').map((e) => structuredClone(e))
    const both = list.find((e) => e.outcome === 'both')
    if (both) both.sys = sys(false, false)
    expect(derive('run1', list)).not.toEqual(real)
    expect(derive('run1', list.slice(1))).not.toEqual(real)
    const help = E({ month: '2026-08', sys: sys(false, true) }) // a helping doc cancels exclusive, not incremental
    expect(derive('a4', [help]).cells[1]).toMatchObject({
      incremental: 1,
      exclusive: 0,
    })
    const early = E({ id: 'a-ag-002', month: '2025-12' }) // before the legacy store's first record
    expect(derive('a4', [early]).cells[1]).toMatchObject({ n: 0 })
  })

  test('recorded agreement covers every pool with stats in range and a 30% sample', () => {
    for (const run of ['run1', 'a4'] as const) {
      const rec = at('header', 'recorded', 'agreement', run) as Obj
      expect(Object.keys(rec).sort()).toEqual(['ag', 'gh', 'in', 'sp'])
      for (const [pool, a] of Object.entries(rec) as [string, Obj][]) {
        const n = inPool(entriesOf(run), pool).length
        expect(a.n).toBe(Math.ceil(0.3 * n))
        for (const k of ['kappa', 'jaccard', 'outcome_agree']) {
          expect(a[k]).toBeGreaterThanOrEqual(0)
          expect(a[k]).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('the raw-text guard', () => {
  test('raw entries and totals carry no banned field, long value, session id or thread number', () => {
    for (const run of ['run1', 'a4'] as const) {
      expect(rawTextProblems(rawList(run))).toEqual([])
      expect(rawTextProblems(at(run, 'totals'))).toEqual([])
    }
    expect([SESSION.test(TEXT), THREAD.test(TEXT)]).toEqual([false, false])
  })

  test('error path: each kind of raw text fails the guard', () => {
    expect(rawTextProblems({ sentence: 'x' })).toEqual(['field sentence'])
    expect(rawTextProblems({ id: 'x'.repeat(200) })).toEqual(['long value'])
    expect(rawTextProblems({ id: 'ses_ed4b81838ffexANEJy3eDT0t6i' })).toEqual([
      'session id',
    ])
    expect(rawTextProblems([{ id: 'see #1234' }])).toEqual(['thread number'])
    expect(rawTextProblems({ id: 'n-ag-001', stores: {} })).toEqual([])
  })
})
