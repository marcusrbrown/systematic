import { describe, expect, it } from 'bun:test'
import {
  BM25F_PARAMS,
  buildLexicalIndex,
  LEXICAL_FIELDS,
  type LexicalDocument,
  ln,
  MAX_QUERY_TERMS,
  searchLexical,
  tokenize,
  uniqueQueryTerms,
} from '../../src/lib/search-lexical.js'

describe('tokenize', () => {
  const table: ReadonlyArray<readonly [string, string, string[]]> = [
    ['underscore joins', 'foo_bar', ['foo_bar', 'foo', 'bar']],
    [
      'hyphen slug lowercased',
      'A-Perfect-Measurement',
      ['a-perfect-measurement', 'a', 'perfect', 'measurement'],
    ],
    ['path splits on slash and dot', 'src/lib/x.ts', ['src', 'lib', 'x', 'ts']],
    ['digits stay in the word', 'v2', ['v2']],
    ['plain words', 'Hello World', ['hello', 'world']],
    ['mixed separators in one run', 'a-b_c', ['a-b_c', 'a', 'b', 'c']],
    ['empty input', '', []],
    ['whitespace only', '  \t\n ', []],
    ['leading underscore and trailing hyphen are not joins', '_x-', ['x']],
    [
      'doubled separators stay in the whole identifier',
      'a__b',
      ['a__b', 'a', 'b'],
    ],
    ['non-ASCII letters split a word', 'naïve', ['na', 've']],
    ['punctuation only', '--__!!', []],
    ['no camelCase split', 'camelCaseWord', ['camelcaseword']],
    ['no stopword removal', 'the and of', ['the', 'and', 'of']],
    ['single-letter runs survive', 'a b', ['a', 'b']],
    [
      'two joined runs side by side',
      'foo_bar baz-qux',
      ['foo_bar', 'foo', 'bar', 'baz-qux', 'baz', 'qux'],
    ],
    ['repeated token repeats in output', 'go go', ['go', 'go']],
  ]

  for (const [name, input, expected] of table) {
    it(`${name}: ${JSON.stringify(input)}`, () => {
      expect(tokenize(input)).toEqual(expected)
    })
  }

  it('does not hang on a 100 KB single token', () => {
    const started = performance.now()
    const tokens = tokenize('a'.repeat(100_000))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.length).toBe(100_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('does not hang on 100 KB of separators or alternating joins', () => {
    const started = performance.now()
    expect(tokenize(`a${'_'.repeat(100_000)}`)).toEqual(['a'])
    expect(tokenize('-_'.repeat(50_000))).toEqual([])
    const joined = tokenize('a-'.repeat(25_000))
    expect(joined).toHaveLength(25_001)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('uniqueQueryTerms', () => {
  it('keeps first-seen uniqueness, then sorts by code unit', () => {
    const { terms, truncated } = uniqueQueryTerms('zebra apple zebra Mango')
    expect(terms).toEqual(['apple', 'mango', 'zebra'])
    expect(truncated).toBe(false)
  })

  it('truncates to 64 in first-seen order before sorting, and says so', () => {
    const words = Array.from({ length: 70 }, (_, i) => `w${String(99 - i)}`)
    const { terms, truncated } = uniqueQueryTerms(words.join(' '))
    expect(MAX_QUERY_TERMS).toBe(64)
    expect(terms).toHaveLength(64)
    expect(truncated).toBe(true)
    // The first 64 words are w99..w36; the last six (w35..w30) are cut.
    expect(terms).toContain('w36')
    expect(terms).not.toContain('w35')
    expect([...terms]).toEqual([...terms].sort())
  })

  it('returns no terms for an empty query', () => {
    expect(uniqueQueryTerms('  ')).toEqual({ terms: [], truncated: false })
  })
})

describe('ln', () => {
  function relativeError(x: number): number {
    const expected = Math.log(x)
    return Math.abs((ln(x) - expected) / expected)
  }

  it('is exactly 0 at 1', () => {
    expect(ln(1)).toBe(0)
    expect(Object.is(ln(1), 0)).toBe(true)
  })

  it('matches Math.log within 1e-15 relative error from 1 to 2N+2 for several N', () => {
    for (const n of [1, 2, 50, 126, 2000]) {
      const upper = 2 * n + 2
      // Integer-ish sweep across the whole range.
      for (let x = 1.0000001; x <= upper; x += upper / 4000) {
        expect(relativeError(x)).toBeLessThan(1e-15)
      }
      // The exact arguments IDF sends: 1 + (N - df + 0.5) / (df + 0.5).
      for (let df = 0; df <= n; df += Math.max(1, Math.floor(n / 200))) {
        const arg = 1 + (n - df + 0.5) / (df + 0.5)
        expect(relativeError(arg)).toBeLessThan(1e-15)
      }
    }
  })

  it('is accurate just above 1, where the result is tiny', () => {
    for (const eps of [1e-3, 1e-6, 1e-9, 1e-12, 2 ** -40]) {
      expect(relativeError(1 + eps)).toBeLessThan(1e-15)
    }
  })

  it('is monotonic on a dense sweep', () => {
    let previous = ln(1)
    for (let x = 1 + 1 / 1024; x <= 64; x += 1 / 1024) {
      const current = ln(x)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
    for (let x = 64; x <= 4_002; x *= 1.0001) {
      const current = ln(x)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  it('handles the edges without throwing', () => {
    expect(ln(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(ln(-1)).toBeNaN()
    expect(ln(Number.NaN)).toBeNaN()
    expect(ln(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(Math.abs(ln(0.5) - Math.log(0.5))).toBeLessThan(1e-15)
    expect(Math.abs(ln(1e300) / Math.log(1e300) - 1)).toBeLessThan(1e-15)
    expect(Math.abs(ln(5e-324) / Math.log(5e-324) - 1)).toBeLessThan(1e-15)
  })
})

function doc(id: string, fields: LexicalDocument['fields']): LexicalDocument {
  return { id, fields }
}

function scoreOf(
  docs: readonly LexicalDocument[],
  query: string,
  id: string,
): number {
  const index = buildLexicalIndex(docs)
  const hit = searchLexical(index, uniqueQueryTerms(query).terms).find(
    (h) => h.id === id,
  )
  return hit?.score ?? 0
}

describe('BM25F parameters', () => {
  it('publishes one table covering every field in fixed order', () => {
    expect([...LEXICAL_FIELDS]).toEqual([
      'title',
      'tags',
      'module',
      'symptoms',
      'applies_when',
      'component',
      'problem_type',
      'body',
    ])
    expect(BM25F_PARAMS.k1).toBe(1.2)
    expect(BM25F_PARAMS.fields.title).toEqual({ weight: 3, b: 0 })
    expect(BM25F_PARAMS.fields.symptoms).toEqual({ weight: 3, b: 0 })
    expect(BM25F_PARAMS.fields.tags).toEqual({ weight: 2.5, b: 0 })
    expect(BM25F_PARAMS.fields.applies_when).toEqual({ weight: 2, b: 0 })
    expect(BM25F_PARAMS.fields.module).toEqual({ weight: 2, b: 0 })
    expect(BM25F_PARAMS.fields.component).toEqual({ weight: 1.5, b: 0 })
    expect(BM25F_PARAMS.fields.problem_type).toEqual({ weight: 1.5, b: 0 })
    expect(BM25F_PARAMS.fields.body).toEqual({ weight: 1, b: 0.75 })
  })
})

describe('searchLexical', () => {
  const filler = [
    doc('docs/solutions/f1.md', {
      title: 'unrelated cache note',
      body: 'alpha beta gamma',
    }),
    doc('docs/solutions/f2.md', {
      title: 'another subject',
      body: 'delta epsilon zeta',
    }),
    doc('docs/solutions/f3.md', {
      title: 'third thing',
      body: 'eta theta iota',
    }),
  ]

  it('ranks a title hit above the same term once in the body', () => {
    const docs = [
      doc('docs/solutions/title.md', {
        title: 'widget',
        body: 'plain words here',
      }),
      doc('docs/solutions/body.md', {
        title: 'other',
        body: 'widget plain words here',
      }),
      ...filler,
    ]
    const hits = searchLexical(buildLexicalIndex(docs), ['widget'])
    expect(hits.map((h) => h.id)).toEqual([
      'docs/solutions/title.md',
      'docs/solutions/body.md',
    ])
    const [first, second] = hits
    expect(first?.score).toBeGreaterThan(
      second?.score ?? Number.POSITIVE_INFINITY,
    )
  })

  it('scores a rarer term above a common one', () => {
    const docs = [
      doc('docs/solutions/a.md', { body: 'common rare' }),
      doc('docs/solutions/b.md', { body: 'common' }),
      doc('docs/solutions/c.md', { body: 'common' }),
      doc('docs/solutions/d.md', { body: 'common' }),
    ]
    expect(scoreOf(docs, 'rare', 'docs/solutions/a.md')).toBeGreaterThan(
      scoreOf(docs, 'common', 'docs/solutions/a.md'),
    )
  })

  it('lowers the score of a longer body for equal term counts', () => {
    const docs = [
      doc('docs/solutions/short.md', { body: 'needle once' }),
      doc('docs/solutions/long.md', {
        body: `needle once ${'padding '.repeat(200)}`,
      }),
      ...filler,
    ]
    expect(scoreOf(docs, 'needle', 'docs/solutions/short.md')).toBeGreaterThan(
      scoreOf(docs, 'needle', 'docs/solutions/long.md'),
    )
  })

  it('does not length-normalise metadata fields (b = 0)', () => {
    const docs = [
      doc('docs/solutions/short.md', { title: 'needle' }),
      doc('docs/solutions/long.md', { title: `needle ${'pad '.repeat(50)}` }),
      ...filler,
    ]
    expect(scoreOf(docs, 'needle', 'docs/solutions/short.md')).toBe(
      scoreOf(docs, 'needle', 'docs/solutions/long.md'),
    )
  })

  it('returns an empty list for an empty corpus', () => {
    const index = buildLexicalIndex([])
    expect(searchLexical(index, ['anything'])).toEqual([])
  })

  it('scores a one-document corpus finitely', () => {
    const index = buildLexicalIndex([
      doc('docs/solutions/only.md', { title: 'solo', body: 'solo doc' }),
    ])
    const hits = searchLexical(index, ['solo'])
    expect(hits).toHaveLength(1)
    const score = hits[0]?.score ?? Number.NaN
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThan(0)
  })

  it('returns no hit and no NaN for a term in no document', () => {
    const index = buildLexicalIndex(filler)
    expect(searchLexical(index, ['absent'])).toEqual([])
    const mixed = searchLexical(index, ['absent', 'alpha'])
    expect(mixed).toHaveLength(1)
    expect(Number.isNaN(mixed[0]?.score)).toBe(false)
  })

  it('returns nothing for no terms', () => {
    expect(searchLexical(buildLexicalIndex(filler), [])).toEqual([])
  })

  it('treats missing, empty and absent fields alike', () => {
    const docs = [
      doc('docs/solutions/a.md', { title: 'x', tags: '' }),
      doc('docs/solutions/b.md', {}),
      ...filler,
    ]
    const hits = searchLexical(buildLexicalIndex(docs), ['x'])
    expect(hits.map((h) => h.id)).toEqual(['docs/solutions/a.md'])
  })

  it('gives bit-identical scores for permuted and duplicated query terms', () => {
    const docs = [
      doc('docs/solutions/a.md', {
        title: 'database timeout retry',
        symptoms: 'connection reset during retry storm',
        tags: 'database, retry',
        body: 'the retry loop hammered the database after each timeout',
      }),
      doc('docs/solutions/b.md', {
        title: 'cache invalidation',
        body: 'stale cache after deploy, retry fixed it',
      }),
      doc('docs/solutions/c.md', { body: 'timeout in the database layer' }),
      ...filler,
    ]
    const index = buildLexicalIndex(docs)
    const terms = ['retry', 'database', 'timeout', 'cache', 'storm']
    const baseline = searchLexical(index, terms)
    const permutations = [
      [...terms].reverse(),
      ['storm', 'retry', 'cache', 'timeout', 'database'],
      [...terms, 'retry', 'cache'],
    ]
    for (const permuted of permutations) {
      const result = searchLexical(index, permuted)
      expect(result.map((h) => h.id)).toEqual(baseline.map((h) => h.id))
      expect(result.map((h) => Object.is(h.score, h.score) && h.score)).toEqual(
        baseline.map((h) => h.score),
      )
    }
  })

  it('orders equal scores by code-unit path, so Z.md sorts before a.md', () => {
    const docs = [
      doc('docs/solutions/a.md', { title: 'tie' }),
      doc('docs/solutions/Z.md', { title: 'tie' }),
      doc('docs/solutions/m.md', { title: 'tie' }),
      doc('docs/solutions/other.md', { title: 'different' }),
    ]
    const hits = searchLexical(buildLexicalIndex(docs), ['tie'])
    expect(hits.map((h) => h.id)).toEqual([
      'docs/solutions/Z.md',
      'docs/solutions/a.md',
      'docs/solutions/m.md',
    ])
    expect(new Set(hits.map((h) => h.score)).size).toBe(1)
  })

  it('does not depend on the order the documents were supplied in', () => {
    const docs = [
      doc('docs/solutions/a.md', { title: 'alpha tie', body: 'one two' }),
      doc('docs/solutions/b.md', { title: 'alpha', body: 'one' }),
      doc('docs/solutions/c.md', { body: 'alpha one two three' }),
      ...filler,
    ]
    const forward = searchLexical(buildLexicalIndex(docs), ['alpha', 'one'])
    const backward = searchLexical(buildLexicalIndex([...docs].reverse()), [
      'alpha',
      'one',
    ])
    expect(backward).toEqual(forward)
  })

  it('counts df over docs where the term appears in any field, and matches the formula', () => {
    // 'zap' sits in two fields of one document: df is 1, not 2.
    const docs = [
      doc('docs/solutions/a.md', { title: 'zap', body: 'zap pad pad pad' }),
      doc('docs/solutions/b.md', { body: 'other words here now' }),
      doc('docs/solutions/c.md', { body: 'other words here now' }),
    ]
    const n = 3
    const df = 1
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    // Body length 4 vs a mean of (4 + 4 + 4) / 3, so its normaliser is 1.
    const wtf = 3 * 1 + (1 * 1) / (1 - 0.75 + 0.75 * (4 / 4))
    const expected = (idf * wtf) / (1.2 + wtf)
    expect(
      Math.abs(scoreOf(docs, 'zap', 'docs/solutions/a.md') - expected),
    ).toBeLessThan(1e-12)
  })
})
