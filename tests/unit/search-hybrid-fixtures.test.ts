import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// Shape and hygiene checks for the hybrid-search evaluation fixtures. Nothing
// here runs a ranker. The tune file holds vocabulary-disjoint paraphrases
// (committed kinds only); the evidence file holds the outcome of a run that
// stopped at its floor. Neither stores raw mined text or a session id. The
// disjointness check needs the corpus and the tokenizer, so it ran in the
// evaluation harness; this test re-checks shape only.

const ROOT = path.resolve(import.meta.dirname, '../..')
const readJson = (rel: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))

const KIND_DIR = {
  solution: 'docs/solutions/',
  plan: 'docs/plans/',
  brainstorm: 'docs/brainstorms/',
  ideation: 'docs/ideation/',
} as const
type Kind = keyof typeof KIND_DIR

const EVIDENCE_ID = /^q-h\d{3}$/
const TUNE_ID = /^q-t\d{3}$/
const SOURCES = ['dispatch', 'user', 'gh'] as const
const STRATA = ['6-20', 'over-20', 'no-overlap'] as const
/** A session id from the evaluated host looks like `ses_` plus 20+ alphanumerics. */
const SESSION_ID = /\bses_[A-Za-z0-9]{12,}\b/
/** Longest free-text value allowed anywhere in a fixture entry: a repo path. */
const MAX_VALUE_LENGTH = 160
/** Field names that would carry raw text. */
const RAW_TEXT_KEYS = new Set([
  'query',
  'sentence',
  'need',
  'text',
  'prompt',
  'title',
  'body',
  'converted_query',
  'raw',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && value in KIND_DIR
}

/** Every string value and key in a JSON tree. */
function walk(
  value: unknown,
  visit: (key: string | undefined, text: string) => void,
  key?: string,
): void {
  if (typeof value === 'string') visit(key, value)
  else if (Array.isArray(value)) for (const v of value) walk(v, visit, key)
  else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      visit(k, '')
      walk(v, visit, k)
    }
  }
}

/** Fails when an entry holds a raw-text field, a long free-text value or a session id. */
function rawTextProblems(entry: unknown): string[] {
  const problems = new Set<string>()
  walk(entry, (key, text) => {
    if (key !== undefined && RAW_TEXT_KEYS.has(key)) {
      problems.add(`raw-text field "${key}"`)
    }
    if (text.length > MAX_VALUE_LENGTH) {
      problems.add(`value longer than a path (${text.length} chars)`)
    }
    if (SESSION_ID.test(text)) problems.add('session id pattern')
  })
  return [...problems]
}

const SHAPES = [
  'pastwork',
  'solutions',
  'all',
  'sentence_form_pastwork',
] as const
type Shape = (typeof SHAPES)[number]

/**
 * Problems with one lexical outcome: `found` must be a boolean, a miss names a known stratum and a find has none.
 * Only the solutions shape may be `applicable: false`, and then it carries neither `found` nor a stratum.
 */
function outcomeProblems(o: unknown, shape: Shape): string[] {
  if (!isRecord(o)) return ['outcome is not an object']
  if ('applicable' in o && shape !== 'solutions') {
    return [`${shape} outcome has an applicable field`]
  }
  if (o.applicable === false) {
    return 'found' in o || 'miss_stratum' in o
      ? ['not-applicable outcome reports found or a stratum']
      : []
  }
  if (typeof o.found !== 'boolean') return ['outcome has no boolean found flag']
  if (o.found) {
    return 'miss_stratum' in o ? ['found outcome carries a stratum'] : []
  }
  return STRATA.some((x) => x === o.miss_stratum)
    ? []
    : ['miss has no known stratum']
}

interface Target {
  path: string
  kind: Kind
  ci_reproducible?: false
}

/** Problems with one target entry: path/kind agreement and the brainstorm flag rule. */
function targetProblems(raw: unknown): string[] {
  if (!isRecord(raw) || typeof raw.path !== 'string' || !isKind(raw.kind)) {
    return ['bad target entry']
  }
  const problems: string[] = []
  if (!raw.path.startsWith(KIND_DIR[raw.kind]) || !raw.path.endsWith('.md')) {
    problems.push(`${raw.path}: path does not match kind ${raw.kind}`)
  }
  if (raw.path.includes('..')) problems.push(`${raw.path}: path escapes`)
  if (raw.kind === 'brainstorm') {
    if (raw.ci_reproducible !== false) {
      problems.push(
        `${raw.path}: brainstorm target needs ci_reproducible:false`,
      )
    }
  } else if ('ci_reproducible' in raw) {
    problems.push(`${raw.path}: committed kind must not set ci_reproducible`)
  }
  return problems
}

function parseTarget(t: unknown): Target {
  if (!isRecord(t) || typeof t.path !== 'string' || !isKind(t.kind)) {
    throw new Error('bad target')
  }
  return {
    path: t.path,
    kind: t.kind,
    ...(t.ci_reproducible === false ? { ci_reproducible: false as const } : {}),
  }
}

/** Every path an entry lists: `primary` always, plus `targets` when present. */
function listedTargets(entry: Record<string, unknown>): Target[] {
  const listed = [parseTarget(entry.primary)]
  if (Array.isArray(entry.targets))
    listed.push(...entry.targets.map(parseTarget))
  return listed
}

/** True when lexical missed the entry in at least one call shape. */
function missedInSomeShape(entry: Record<string, unknown>): boolean {
  const lexical = isRecord(entry.lexical) ? entry.lexical : {}
  return SHAPES.some((shape) => {
    const o = lexical[shape]
    return isRecord(o) && o.found === false
  })
}

/** The `targets` rule: a full list exactly when lexical missed, and `primary` is among it. */
function targetsListProblems(entry: Record<string, unknown>): string[] {
  const missed = missedInSomeShape(entry)
  const has = 'targets' in entry
  if (missed && !has) return ['missed entry has no targets']
  if (!missed && has) return ['entry lexical never missed but lists targets']
  if (!has) return []
  if (!Array.isArray(entry.targets) || entry.targets.length === 0) {
    return ['targets is empty']
  }
  const paths = entry.targets.map((t) => (isRecord(t) ? t.path : undefined))
  const problems: string[] = []
  if (new Set(paths).size !== paths.length) problems.push('duplicate targets')
  const primary = isRecord(entry.primary) ? entry.primary.path : undefined
  if (!paths.includes(primary))
    problems.push('primary is not among the targets')
  return problems
}

const KIND_KEYS = ['solution', 'plan', 'brainstorm'] as const

/** Every count the fixture records as `totals`, recomputed from the entries alone. */
function deriveTotals(entries: Record<string, unknown>[]) {
  const outcome = (e: Record<string, unknown>, shape: Shape) => {
    const l = isRecord(e.lexical) ? e.lexical : {}
    const o = l[shape]
    return isRecord(o) ? o : {}
  }
  const primaryKind = (e: Record<string, unknown>) =>
    isRecord(e.primary) ? e.primary.kind : undefined
  const missed = (e: Record<string, unknown>, shape: Shape) =>
    outcome(e, shape).found === false
  const strata = (shape: Shape) => {
    const m: Record<string, number> = {}
    for (const e of entries) {
      const o = outcome(e, shape)
      if (o.found === false) {
        const k = String(o.miss_stratum)
        m[k] = (m[k] ?? 0) + 1
      }
    }
    return m
  }
  const bySource: Record<string, number> = {}
  for (const e of entries) {
    bySource[String(e.source)] = (bySource[String(e.source)] ?? 0) + 1
  }
  const solutionPrimary = entries.filter((e) => primaryKind(e) === 'solution')
  return {
    representatives: entries.length,
    by_source: bySource,
    by_target_kind: Object.fromEntries(
      KIND_KEYS.map((k) => [
        k,
        entries.filter((e) => primaryKind(e) === k).length,
      ]),
    ),
    pastwork_misses: entries.filter((e) => missed(e, 'pastwork')).length,
    solutions_shape: {
      applicable: entries.filter(
        (e) => outcome(e, 'solutions').applicable === true,
      ).length,
      misses: entries.filter((e) => missed(e, 'solutions')).length,
      primary_solution_queries: solutionPrimary.length,
      primary_solution_misses: solutionPrimary.filter((e) =>
        missed(e, 'solutions'),
      ).length,
    },
    all_shape_misses: entries.filter((e) => missed(e, 'all')).length,
    sentence_form_pastwork_misses: entries.filter((e) =>
      missed(e, 'sentence_form_pastwork'),
    ).length,
    miss_strata: {
      pastwork: strata('pastwork'),
      solutions: strata('solutions'),
      all: strata('all'),
      sentence_form_pastwork: strata('sentence_form_pastwork'),
    },
  }
}

const evidence = readJson('tests/fixtures/search-hybrid-evidence.json')
const tune = readJson('tests/fixtures/search-hybrid-tune.json')

/** The `queries` array of a fixture; every element must be a record, so a stray string or null fails instead of being skipped. */
function entriesOf(fixture: unknown, name: string): Record<string, unknown>[] {
  if (!isRecord(fixture) || !Array.isArray(fixture.queries)) {
    throw new Error(`${name} fixture has no queries array`)
  }
  return fixture.queries.map((q, i) => {
    if (!isRecord(q)) throw new Error(`${name} queries[${i}] is not a record`)
    return q
  })
}
function evidenceEntries(): Record<string, unknown>[] {
  return entriesOf(evidence, 'evidence')
}
function tuneEntries(): Record<string, unknown>[] {
  return entriesOf(tune, 'tune')
}

describe('fixture shape', () => {
  test('both fixtures parse and every id matches its pattern and is unique', () => {
    const ev = evidenceEntries()
    const tu = tuneEntries()
    expect(ev.length).toBe(60)
    expect(tu.length).toBeGreaterThan(0)
    for (const e of ev) expect(String(e.id)).toMatch(EVIDENCE_ID)
    for (const t of tu) expect(String(t.id)).toMatch(TUNE_ID)
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length)
    expect(new Set(tu.map((t) => t.id)).size).toBe(tu.length)
  })

  test('evidence entries carry a known source, a primary target, and lexical outcomes for every shape', () => {
    for (const e of evidenceEntries()) {
      expect(SOURCES.some((s) => s === e.source)).toBe(true)
      expect(targetProblems(e.primary)).toEqual([])
      expect(typeof e.primary_has_symptoms).toBe('boolean')
      expect(typeof e.any_target_has_symptoms).toBe('boolean')
      if (e.primary_has_symptoms === true) {
        expect(e.any_target_has_symptoms).toBe(true)
      }
      const lexical = isRecord(e.lexical) ? e.lexical : {}
      expect(Object.keys(lexical).sort()).toEqual([...SHAPES].sort())
    }
  })

  test('a full targets list appears exactly on entries that lexical missed in some shape', () => {
    let withTargets = 0
    for (const e of evidenceEntries()) {
      expect(targetsListProblems(e)).toEqual([])
      if ('targets' in e) withTargets++
    }
    expect(withTargets).toBeGreaterThan(0)
    expect(withTargets).toBeLessThan(evidenceEntries().length)
  })

  test('error path: an entry that missed but has no targets fails; one that never missed but has targets fails', () => {
    const found = { found: true }
    const missed = { found: false, miss_stratum: '6-20' }
    const base = {
      id: 'q-h001',
      source: 'gh',
      primary: { path: 'docs/solutions/a.md', kind: 'solution' },
    }
    const targets = [{ path: 'docs/solutions/a.md', kind: 'solution' }]
    const lexicalWith = (pastwork: object, sentence: object = found) => ({
      pastwork,
      solutions: { applicable: false },
      all: found,
      sentence_form_pastwork: sentence,
    })
    // missed in the past-work shape, no targets
    expect(
      targetsListProblems({ ...base, lexical: lexicalWith(missed) }),
    ).toEqual(['missed entry has no targets'])
    // missed only in the sentence-form shape still counts as a miss
    expect(
      targetsListProblems({ ...base, lexical: lexicalWith(found, missed) }),
    ).toEqual(['missed entry has no targets'])
    // never missed, targets present
    expect(
      targetsListProblems({ ...base, targets, lexical: lexicalWith(found) }),
    ).toEqual(['entry lexical never missed but lists targets'])
    // the two valid forms
    expect(
      targetsListProblems({ ...base, targets, lexical: lexicalWith(missed) }),
    ).toEqual([])
    expect(
      targetsListProblems({ ...base, lexical: lexicalWith(found) }),
    ).toEqual([])
    // a list that omits the primary fails
    expect(
      targetsListProblems({
        ...base,
        targets: [{ path: 'docs/solutions/b.md', kind: 'solution' }],
        lexical: lexicalWith(missed),
      }),
    ).toEqual(['primary is not among the targets'])
  })

  test('every shape, sentence-form included, has a boolean found; a miss names a stratum and a find has none', () => {
    for (const e of evidenceEntries()) {
      const lexical = isRecord(e.lexical) ? e.lexical : {}
      for (const shape of SHAPES) {
        expect(outcomeProblems(lexical[shape], shape)).toEqual([])
      }
    }
  })

  test('error path: malformed outcomes fail, sentence-form ones included', () => {
    const bad = (o: unknown, shape: Shape = 'pastwork') =>
      outcomeProblems(o, shape)
    expect(bad({ found: false })).toHaveLength(1)
    expect(bad({ found: true, miss_stratum: '6-20' })).toHaveLength(1)
    expect(bad({ applicable: false, found: true }, 'solutions')).toHaveLength(1)
    expect(bad({ found: false, miss_stratum: 'deep' })).toHaveLength(1)
    // sentence-form: the same rules, and no applicable field
    expect(bad({ found: false }, 'sentence_form_pastwork')).toHaveLength(1)
    expect(bad({ found: 'false' }, 'sentence_form_pastwork')).toHaveLength(1)
    expect(bad({}, 'sentence_form_pastwork')).toHaveLength(1)
    expect(bad(null, 'sentence_form_pastwork')).toHaveLength(1)
    expect(
      bad({ found: true, miss_stratum: '6-20' }, 'sentence_form_pastwork'),
    ).toHaveLength(1)
    expect(
      bad({ applicable: true, found: true }, 'sentence_form_pastwork'),
    ).toHaveLength(1)
    // the valid forms
    expect(bad({ found: false, miss_stratum: '6-20' })).toEqual([])
    expect(bad({ found: true })).toEqual([])
    expect(bad({ applicable: false }, 'solutions')).toEqual([])
    expect(
      bad({ found: false, miss_stratum: 'over-20' }, 'sentence_form_pastwork'),
    ).toEqual([])
    expect(bad({ found: true }, 'sentence_form_pastwork')).toEqual([])
  })

  test('error path: a non-record element in queries fails instead of being skipped', () => {
    const ok = evidenceEntries()
    expect(() => entriesOf({ queries: ok }, 'evidence')).not.toThrow()
    expect(() =>
      entriesOf(
        { queries: [...ok, 'why did the build fail after my edit'] },
        'evidence',
      ),
    ).toThrow('queries[60] is not a record')
    expect(() => entriesOf({ queries: [...ok, null] }, 'evidence')).toThrow()
    expect(() => entriesOf({ queries: [...ok, [1]] }, 'evidence')).toThrow()
    expect(() => entriesOf({}, 'evidence')).toThrow('no queries array')
  })

  test('every recorded total equals the value derived from the entries', () => {
    if (!isRecord(evidence)) throw new Error('no evidence')
    expect(evidence.totals).toEqual(deriveTotals(evidenceEntries()))
  })

  test('deriveTotals counts each total independently; a wrong recorded value would differ', () => {
    const miss = (stratum: string) => ({ found: false, miss_stratum: stratum })
    const entry = (
      id: string,
      source: string,
      primaryKind: Kind,
      lexical: Record<string, unknown>,
    ) => ({
      id,
      source,
      primary: { path: `${KIND_DIR[primaryKind]}a.md`, kind: primaryKind },
      lexical,
    })
    const found = { found: true }
    const entries = [
      entry('q-h001', 'gh', 'solution', {
        pastwork: miss('6-20'),
        solutions: { applicable: true, ...miss('6-20') },
        all: miss('over-20'),
        sentence_form_pastwork: miss('no-overlap'),
      }),
      entry('q-h002', 'user', 'plan', {
        pastwork: found,
        solutions: { applicable: true, found: true },
        all: found,
        sentence_form_pastwork: found,
      }),
      entry('q-h003', 'gh', 'brainstorm', {
        pastwork: found,
        solutions: { applicable: false },
        all: miss('6-20'),
        sentence_form_pastwork: miss('6-20'),
      }),
    ]
    expect(deriveTotals(entries)).toEqual({
      representatives: 3,
      by_source: { gh: 2, user: 1 },
      by_target_kind: { solution: 1, plan: 1, brainstorm: 1 },
      pastwork_misses: 1,
      solutions_shape: {
        applicable: 2,
        misses: 1,
        primary_solution_queries: 1,
        primary_solution_misses: 1,
      },
      all_shape_misses: 2,
      sentence_form_pastwork_misses: 2,
      miss_strata: {
        pastwork: { '6-20': 1 },
        solutions: { '6-20': 1 },
        all: { 'over-20': 1, '6-20': 1 },
        sentence_form_pastwork: { 'no-overlap': 1, '6-20': 1 },
      },
    })
    // a tampered copy of the real totals differs
    const real = deriveTotals(evidenceEntries())
    expect({ ...real, sentence_form_pastwork_misses: 0 }).not.toEqual(real)
  })

  test('the floor stop is explicit: the run is below the floor and candidates are marked not applicable', () => {
    if (!isRecord(evidence) || !isRecord(evidence.header)) {
      throw new Error('no header')
    }
    expect(evidence.header.outcome).toBe('floor-stop')
    expect(evidence.header.floor).toBe(8)
    if (!isRecord(evidence.totals)) throw new Error('no totals')
    expect(Number(evidence.totals.pastwork_misses)).toBeLessThan(
      Number(evidence.header.floor),
    )
    if (!isRecord(evidence.candidates)) throw new Error('no candidates')
    expect(evidence.candidates.status).toBe('not-applicable')
    expect(String(evidence.candidates.reason).length).toBeGreaterThan(0)
    // No entry may carry a per-candidate outcome.
    for (const e of evidenceEntries()) {
      expect('candidates' in e).toBe(false)
    }
  })
})

describe('no raw mined text, no session ids', () => {
  test('neither fixture trips the raw-text check', () => {
    for (const e of evidenceEntries()) {
      expect(rawTextProblems(e)).toEqual([])
    }
    for (const t of tuneEntries()) {
      // A paraphrase is the one free-text field the tune file may hold.
      const { paraphrase, ...rest } = t
      expect(typeof paraphrase).toBe('string')
      expect(rawTextProblems(rest)).toEqual([])
    }
    if (isRecord(evidence)) {
      expect(rawTextProblems(evidence.totals)).toEqual([])
      expect(rawTextProblems(evidence.candidates)).toEqual([])
    }
  })

  test('error path: a long free-text value, a session id or a raw-text field fails the check', () => {
    expect(rawTextProblems({ id: 'q-h001', note: 'x'.repeat(200) })).toEqual([
      'value longer than a path (200 chars)',
    ])
    expect(
      rawTextProblems({
        id: 'q-h001',
        origin: 'ses_ed4b81838ffexANEJy3eDT0t6i',
      }),
    ).toEqual(['session id pattern'])
    expect(rawTextProblems({ id: 'q-h001', query: 'why did X' })).toEqual([
      'raw-text field "query"',
    ])
    expect(
      rawTextProblems({ id: 'q-h001', source: 'gh', targets: [] }),
    ).toEqual([])
  })

  test('the file text holds no session id anywhere', () => {
    for (const rel of [
      'tests/fixtures/search-hybrid-evidence.json',
      'tests/fixtures/search-hybrid-tune.json',
    ]) {
      expect(
        SESSION_ID.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
      ).toBe(false)
    }
  })
})

describe('targets', () => {
  test('error path: a brainstorm target without ci_reproducible:false fails; a committed-kind target with it set fails', () => {
    expect(
      targetProblems({ path: 'docs/brainstorms/a.md', kind: 'brainstorm' }),
    ).toHaveLength(1)
    expect(
      targetProblems({
        path: 'docs/brainstorms/a.md',
        kind: 'brainstorm',
        ci_reproducible: false,
      }),
    ).toEqual([])
    expect(
      targetProblems({
        path: 'docs/solutions/a.md',
        kind: 'solution',
        ci_reproducible: false,
      }),
    ).toHaveLength(1)
    expect(
      targetProblems({ path: 'docs/solutions/a.md', kind: 'solution' }),
    ).toEqual([])
  })

  test('error path: a path outside its kind directory fails', () => {
    expect(
      targetProblems({ path: 'docs/plans/a.md', kind: 'solution' }),
    ).toHaveLength(1)
  })

  test('every listed path, primary included, passes the flag rule and matches its directory', () => {
    for (const e of evidenceEntries()) {
      const raw = [e.primary, ...(Array.isArray(e.targets) ? e.targets : [])]
      for (const t of raw) expect(targetProblems(t)).toEqual([])
    }
  })

  test('every committed-kind listed path, primary included, exists in the repo; brainstorm paths are skipped', () => {
    for (const e of evidenceEntries()) {
      for (const t of listedTargets(e)) {
        if (t.kind === 'brainstorm') continue
        expect(fs.existsSync(path.join(ROOT, t.path))).toBe(true)
      }
    }
  })
})

describe('tune fixture', () => {
  test('holds committed kinds only and every field is a path or a paraphrase', () => {
    for (const t of tuneEntries()) {
      expect(['solution', 'plan', 'ideation']).toContain(String(t.target_kind))
      expect(Object.keys(t).sort()).toEqual(
        ['id', 'paraphrase', 'target', 'target_kind'].sort(),
      )
      expect(String(t.target).startsWith(KIND_DIR[t.target_kind as Kind])).toBe(
        true,
      )
      expect(String(t.paraphrase).split(/\s+/).length).toBeGreaterThan(4)
      expect(String(t.paraphrase).split(/\s+/).length).toBeLessThanOrEqual(40)
    }
  })

  test('every target path in the tune fixture exists in the repo', () => {
    for (const t of tuneEntries()) {
      expect(fs.existsSync(path.join(ROOT, String(t.target)))).toBe(true)
    }
  })

  test('the tune fixture covers solution, plan and ideation, and paraphrases are unique', () => {
    const tu = tuneEntries()
    expect(new Set(tu.map((t) => t.target_kind))).toEqual(
      new Set(['solution', 'plan', 'ideation']),
    )
    expect(new Set(tu.map((t) => t.paraphrase)).size).toBe(tu.length)
  })
})
