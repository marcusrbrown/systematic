import { describe, expect, it } from 'bun:test'
import type { CorpusDocument } from '../../src/lib/search-corpus.js'
import type { ExternalRecord } from '../../src/lib/search-external.js'
import {
  EXTERNAL_MAX_OUTPUT_BYTES,
  EXTERNAL_REPLIES,
  EXTERNAL_TRUNCATION_MARKER,
  type ExternalSearchResult,
  type ExternalSection,
  extractSnippet,
  MAX_OUTPUT_BYTES,
  renderExternalFixedReply,
  renderExternalResult,
  renderSearchResult,
  type SearchHit,
  type SearchResult,
  sanitizeInline,
  TRUNCATION_MARKER,
  truncateUtf8,
} from '../../src/lib/search-render.js'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const NUL = String.fromCharCode(0)

function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return (code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
  })
}

function makeDocument(overrides: Partial<CorpusDocument> = {}): CorpusDocument {
  return {
    path: 'docs/solutions/best-practices/example-2026-08-16.md',
    kind: 'solution',
    title: 'Example title',
    tags: ['alpha', 'beta'],
    module: 'example-module',
    component: undefined,
    problemType: undefined,
    symptoms: ['first symptom', 'second symptom'],
    appliesWhen: [],
    status: undefined,
    supersededBy: { state: 'none' },
    staleReason: undefined,
    body: 'Body text with nothing special.',
    ...overrides,
  }
}

function makeHit(
  rank: number,
  overrides: Partial<SearchHit> = {},
  document: Partial<CorpusDocument> = {},
): SearchHit {
  return {
    rank,
    document: makeDocument(document),
    status: 'active',
    lifecycle: [],
    ...overrides,
  }
}

type CorpusReport = SearchResult['corpus']
type KindReport = CorpusReport['kinds'][number]

const KIND_DIRS = {
  solution: 'docs/solutions',
  plan: 'docs/plans',
  brainstorm: 'docs/brainstorms',
  ideation: 'docs/ideation',
} as const

function kindReport(
  kind: KindReport['kind'],
  state: KindReport['state'],
  docCount = 0,
): KindReport {
  return { kind, dir: KIND_DIRS[kind], state, docCount }
}

function solutionCorpus(
  state: KindReport['state'],
  docCount: number,
): CorpusReport {
  return { state, docCount, kinds: [kindReport('solution', state, docCount)] }
}

/** A corpus report for a search over every kind, from one state or count per kind. */
function allCorpus(
  solution: KindReport['state'] | number,
  plan: KindReport['state'] | number,
  brainstorm: KindReport['state'] | number,
  ideation: KindReport['state'] | number,
): CorpusReport {
  const make = (
    kind: KindReport['kind'],
    value: KindReport['state'] | number,
  ): KindReport =>
    typeof value === 'number'
      ? kindReport(kind, 'docs', value)
      : kindReport(kind, value)
  const kinds = [
    make('solution', solution),
    make('plan', plan),
    make('brainstorm', brainstorm),
    make('ideation', ideation),
  ]
  const docCount = kinds.reduce((sum, report) => sum + report.docCount, 0)
  const state = kinds.some((report) => report.state === 'docs')
    ? 'docs'
    : kinds.every((report) => report.state === 'none')
      ? 'none'
      : 'empty'
  return { state, docCount, kinds }
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    query: 'example query',
    queryTerms: ['example', 'query'],
    corpus: solutionCorpus('docs', 126),
    hits: [makeHit(1)],
    notes: [],
    warnings: [],
    ...overrides,
  }
}

describe('sanitizeInline', () => {
  it('strips CSI, OSC and bare escape sequences', () => {
    expect(sanitizeInline(`a${ESC}[31mred${ESC}[0m b`)).toBe('ared b')
    expect(sanitizeInline(`x${ESC}]52;c;SGVsbG8=${BEL}y`)).toBe('xy')
    expect(sanitizeInline(`x${ESC}]52;c;SGVsbG8=${ESC}\\y`)).toBe('xy')
    expect(sanitizeInline(`x${ESC}Dy`)).toBe('xy')
  })

  it('turns line breaks and tabs into one space and drops other controls', () => {
    expect(sanitizeInline('a\nb\r\nc\td')).toBe('a b c d')
    expect(sanitizeInline(`a${NUL}b\u0007c\u007fd\u009be`)).toBe('abcde')
  })

  it('drops bidirectional overrides and zero-width characters', () => {
    expect(sanitizeInline('a\u202eb\u200bc\u2066d\ufeffe')).toBe('abcde')
  })

  it('caps the length with an ellipsis and never splits a surrogate pair', () => {
    expect(sanitizeInline('abcdef', 4)).toBe('abc…')
    const clipped = sanitizeInline('ab😀cd', 4)
    expect(clipped).toBe('ab…')
    expect(clipped.length).toBeLessThanOrEqual(4)
    expect(sanitizeInline('abc', 3)).toBe('abc')
  })
})

describe('truncateUtf8', () => {
  it('returns short text unchanged', () => {
    expect(truncateUtf8('héllo', 100, '[cut]')).toBe('héllo')
  })

  it('cuts at a character boundary when a multibyte character straddles the cut', () => {
    // Each é is two bytes. A byte budget of 12 with a 5-byte marker leaves 7,
    // so the cut falls inside the fourth é.
    const text = 'é'.repeat(20)
    const cut = truncateUtf8(text, 12, '[cut]')
    expect(cut.endsWith('[cut]')).toBe(true)
    expect(cut).not.toContain('\ufffd')
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(12)
    const emoji = truncateUtf8('😀'.repeat(20), 13, '[cut]')
    expect(emoji).not.toContain('\ufffd')
    expect(new TextEncoder().encode(emoji).byteLength).toBeLessThanOrEqual(13)
  })

  it('prefers a line boundary and appends the marker on its own line', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}\n${'c'.repeat(30)}`
    const cut = truncateUtf8(text, 80, '[cut]')
    expect(cut).toBe(`${'a'.repeat(30)}\n${'b'.repeat(30)}\n[cut]`)
  })
})

describe('extractSnippet', () => {
  it('centres on the window with the most distinct query terms', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(30)
    const body = `${filler} alpha ${filler} alpha beta gamma ${filler}`
    const snippet = extractSnippet(makeDocument({ body }), [
      'alpha',
      'beta',
      'gamma',
    ])
    expect(snippet).toContain('alpha beta gamma')
    expect(snippet.length).toBeLessThanOrEqual(240)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).not.toContain('\n')
  })

  it('takes the earliest window on a tie', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(30)
    const body = `${filler} first alpha ${filler} second alpha ${filler}`
    const snippet = extractSnippet(makeDocument({ body }), ['alpha'])
    expect(snippet).toContain('first alpha')
    expect(snippet).not.toContain('second alpha')
  })

  it('matches an identifier through its components', () => {
    const body = `${'x '.repeat(300)} the retry_budget field ${'y '.repeat(300)}`
    expect(extractSnippet(makeDocument({ body }), ['budget'])).toContain(
      'retry_budget',
    )
  })

  it('falls back to the symptoms, then the title, when the body has no match', () => {
    const withSymptoms = makeDocument({ body: 'nothing relevant here' })
    expect(extractSnippet(withSymptoms, ['missing'])).toBe(
      'first symptom; second symptom',
    )
    const bare = makeDocument({
      body: 'nothing relevant here',
      symptoms: [],
      title: 'Only a title',
    })
    expect(extractSnippet(bare, ['missing'])).toBe('Only a title')
  })

  it('caps a fallback and a long unbroken match at 240 characters', () => {
    const symptoms = ['s'.repeat(500)]
    const fallback = extractSnippet(makeDocument({ body: '', symptoms }), ['q'])
    expect(fallback.length).toBeLessThanOrEqual(240)
    const longToken = `${'z'.repeat(400)}`
    const body = `needle ${longToken} needle`
    expect(
      extractSnippet(makeDocument({ body }), ['needle']).length,
    ).toBeLessThanOrEqual(240)
    const huge = extractSnippet(makeDocument({ body: longToken }), [longToken])
    expect(huge.length).toBeLessThanOrEqual(240)
  })

  it('strips terminal escapes from the body before windowing', () => {
    const body = `before ${ESC}]52;c;SGVsbG8=${BEL} needle ${ESC}[31mred${ESC}[0m after`
    const snippet = extractSnippet(makeDocument({ body }), ['needle'])
    expect(snippet).toContain('needle')
    expect(snippet).not.toContain(ESC)
    expect(snippet).not.toContain('SGVsbG8')
  })
})

describe('renderSearchResult: header', () => {
  it('separates corpus none, empty and zero hits', () => {
    const none = renderSearchResult(
      makeResult({
        corpus: solutionCorpus('none', 0),
        hits: [],
      }),
    )
    const empty = renderSearchResult(
      makeResult({
        corpus: solutionCorpus('empty', 0),
        hits: [],
      }),
    )
    const zero = renderSearchResult(makeResult({ hits: [] }))
    expect(none).toContain('corpus: none')
    expect(empty).toContain('corpus: empty')
    expect(zero).toContain('126 docs, 0 hits')
    expect(zero).not.toContain('corpus: none')
    expect(zero).not.toContain('corpus: empty')
    expect(new Set([none, empty, zero]).size).toBe(3)
  })

  it('names the one directory a single-kind search reads', () => {
    const corpus = (
      state: KindReport['state'],
      docCount = 0,
    ): CorpusReport => ({
      state,
      docCount,
      kinds: [kindReport('plan', state, docCount)],
    })
    const headerOf = (report: CorpusReport) =>
      renderSearchResult(makeResult({ corpus: report, hits: [] })).split(
        '\n',
      )[0]
    expect(headerOf(corpus('none'))).toBe(
      'Search "example query": corpus: none (no docs/plans/ directory under the project root).',
    )
    expect(headerOf(corpus('empty'))).toBe(
      'Search "example query": corpus: empty (docs/plans/ holds no indexable docs).',
    )
    expect(headerOf(corpus('docs', 3))).toBe(
      'Search "example query": 3 docs, 0 hits. Corpus: docs/plans.',
    )
  })

  it('reports one token per kind for an all search: a count, none or empty', () => {
    const text = renderSearchResult(
      makeResult({ corpus: allCorpus(3, 2, 'none', 'empty') }),
    )
    expect(text.split('\n')[0]).toBe(
      'Search "example query": 5 docs, 1 hit. Corpus: solution 3, plan 2, brainstorm none, ideation empty.',
    )
  })

  it('reads none for an all search only when every kind is none, naming all four directories', () => {
    const header = renderSearchResult(
      makeResult({
        corpus: allCorpus('none', 'none', 'none', 'none'),
        hits: [],
      }),
    ).split('\n')[0]
    expect(header).toBe(
      'Search "example query": corpus: none (no docs/solutions/, docs/plans/, docs/brainstorms/ or docs/ideation/ directory under the project root).',
    )
  })

  it('reads empty for an all search when a directory exists but holds no document', () => {
    const header = renderSearchResult(
      makeResult({
        corpus: allCorpus('none', 'empty', 'none', 'none'),
        hits: [],
      }),
    ).split('\n')[0]
    expect(header).toBe(
      'Search "example query": corpus: empty (no indexable docs: solution none, plan empty, brainstorm none, ideation none).',
    )
  })

  it('reads docs for an all search when one kind has documents and the rest are none', () => {
    const header = renderSearchResult(
      makeResult({ corpus: allCorpus('none', 'none', 'none', 1), hits: [] }),
    ).split('\n')[0]
    expect(header).toBe(
      'Search "example query": 1 doc, 0 hits. Corpus: solution none, plan none, brainstorm none, ideation 1.',
    )
  })

  it('counts the hits and prints no lane segment', () => {
    const text = renderSearchResult(
      makeResult({ hits: [makeHit(1), makeHit(2)] }),
    )
    expect(text.split('\n')[0]).toBe(
      'Search "example query": 126 docs, 2 hits. Corpus: docs/solutions.',
    )
    expect(text).not.toContain('Lanes')
    expect(
      renderSearchResult(makeResult({ corpus: solutionCorpus('docs', 1) })),
    ).toContain('1 doc, 1 hit.')
  })

  it('lists notes and caps warnings at five plus a count', () => {
    const warnings = Array.from({ length: 9 }, (_, i) => `warning ${i}`)
    const text = renderSearchResult(
      makeResult({ notes: ['note one', 'note two'], warnings }),
    )
    expect(text).toContain('Notes: note one; note two')
    for (let i = 0; i < 5; i++) expect(text).toContain(`warning ${i}`)
    expect(text).not.toContain('warning 5')
    expect(text).toContain('+4 more')
    const exactlyFive = renderSearchResult(
      makeResult({ warnings: warnings.slice(0, 5) }),
    )
    expect(exactlyFive).not.toContain('more')
  })
})

describe('renderSearchResult: hits', () => {
  it('shows path, title, kind, rank, status, module, tags and snippet', () => {
    const text = renderSearchResult(
      makeResult({
        hits: [
          makeHit(
            3,
            { status: 'stale' },
            { body: 'the example query appears here' },
          ),
        ],
      }),
    )
    expect(text).toContain(
      '3. docs/solutions/best-practices/example-2026-08-16.md',
    )
    expect(text).toContain(
      'Title: Example title | Kind: solution | Status: stale',
    )
    expect(text).toContain('Module: example-module | Tags: alpha, beta')
    expect(text).toContain('Snippet: the example query appears here')
  })

  it('prints lifecycle lines verbatim after the snippet', () => {
    const text = renderSearchResult(
      makeResult({
        hits: [
          makeHit(1, {
            lifecycle: [
              'Supersedes: docs/solutions/a.md',
              'Caution: successor unresolved',
            ],
          }),
        ],
      }),
    )
    expect(text).toContain('   Supersedes: docs/solutions/a.md')
    expect(text).toContain('   Caution: successor unresolved')
  })

  it('keeps every predecessor path in a long Supersedes: line, and caps the Caution: line as a whole', () => {
    const paths = Array.from(
      { length: 60 },
      (_, index) => `docs/solutions/old-${String(index).padStart(2, '0')}.md`,
    )
    const text = renderSearchResult(
      makeResult({
        hits: [
          makeHit(1, {
            lifecycle: [
              `Supersedes: ${paths.join(', ')}`,
              `Caution: marked stale: ${'r'.repeat(1000)}`,
            ],
          }),
        ],
      }),
    )
    expect(`Supersedes: ${paths.join(', ')}`.length).toBeGreaterThan(400)
    expect(text).toContain(`   Supersedes: ${paths.join(', ')}\n`)
    const caution = text.split('\n').find((l) => l.includes('Caution:')) ?? ''
    expect(caution.length).toBeLessThanOrEqual(3 + 400)
    expect(caution.endsWith('…')).toBe(true)
  })

  it('sanitizes and caps each Supersedes: path on its own', () => {
    const hostilePath = `docs/solutions/${ESC}[31mbad${NUL}${BEL}.md`
    const longPath = `docs/solutions/${'x'.repeat(600)}.md`
    const text = renderSearchResult(
      makeResult({
        hits: [
          makeHit(1, {
            lifecycle: [
              `Supersedes: ${hostilePath}, ${longPath}, docs/solutions/last.md`,
            ],
          }),
        ],
      }),
    )
    expect(hasControlCharacter(text)).toBe(false)
    expect(text).not.toContain(ESC)
    expect(text).toContain('docs/solutions/bad.md')
    expect(text).not.toContain('x'.repeat(401))
    expect(text).toContain('…, docs/solutions/last.md')
  })

  it('omits the module line when there is neither module nor tags', () => {
    const text = renderSearchResult(
      makeResult({
        hits: [makeHit(1, {}, { module: undefined, tags: [] })],
      }),
    )
    expect(text).not.toContain('Module:')
  })

  it('caps the title at 160 characters, tags at 8, and the snippet at 240', () => {
    const tags = Array.from({ length: 12 }, (_, i) => `tag${i}`)
    const text = renderSearchResult(
      makeResult({
        hits: [
          makeHit(
            1,
            {},
            {
              title: 'T'.repeat(400),
              tags,
              body: `example ${'w '.repeat(400)}`,
            },
          ),
        ],
      }),
    )
    const titleLine = text.split('\n').find((l) => l.includes('Title:')) ?? ''
    const title = titleLine.split(' | ')[0]?.replace(/^\s*Title: /, '') ?? ''
    expect(title.length).toBeLessThanOrEqual(160)
    expect(title.endsWith('…')).toBe(true)
    expect(text).toContain('tag7')
    expect(text).not.toContain('tag8')
    const snippetLine =
      text.split('\n').find((l) => l.startsWith('   Snippet: ')) ?? ''
    expect(snippetLine.replace('   Snippet: ', '').length).toBeLessThanOrEqual(
      240,
    )
  })
})

describe('renderSearchResult: sanitising', () => {
  it('strips control and ANSI sequences from everything echoed', () => {
    const hostile = (label: string) =>
      `${label}${ESC}[31m${NUL}\r${ESC}]52;c;SGVsbG8=${BEL}${label}`
    const result = makeResult({
      query: hostile('query'),
      queryTerms: ['query'],
      notes: [hostile('note')],
      warnings: [hostile('warning')],
      hits: [
        makeHit(
          1,
          {
            status: hostile('status') as SearchHit['status'],
            lifecycle: [hostile('lifecycle')],
          },
          {
            path: `docs/solutions/${hostile('path')}.md`,
            title: hostile('title'),
            module: hostile('module'),
            tags: [hostile('tag')],
            body: `${hostile('body')} query ${hostile('tail')}`,
          },
        ),
      ],
    })
    const text = renderSearchResult(result)
    expect(hasControlCharacter(text)).toBe(false)
    expect(text).not.toContain(ESC)
    expect(text).not.toContain('SGVsbG8')
    expect(text).toContain('query')
    expect(text).toContain('title')
    expect(text).toContain('path')
  })
})

describe('renderSearchResult: Successor lines', () => {
  const lineFor = (path: string) =>
    renderSearchResult(
      makeResult({
        hits: [makeHit(1, { lifecycle: [`Successor: ${path}`] })],
      }),
    )
      .split('\n')
      .find((line) => line.includes('Successor:'))

  it('prints the successor path as given', () => {
    expect(lineFor('docs/plans/next.md')).toBe(
      '   Successor: docs/plans/next.md',
    )
  })

  it('strips terminal escapes and control characters from the path', () => {
    const line = lineFor(`docs/plans/${ESC}[31mred${ESC}[0m${NUL}\nx.md`)
    expect(line).toBe('   Successor: docs/plans/red x.md')
    expect(hasControlCharacter(line ?? '')).toBe(false)
  })

  it('caps one path at 400 characters, not the whole result', () => {
    const line = lineFor(`docs/plans/${'p'.repeat(600)}.md`) ?? ''
    expect(line.startsWith('   Successor: docs/plans/')).toBe(true)
    expect(line.length).toBe('   Successor: '.length + 400)
    expect(line.endsWith('…')).toBe(true)
  })

  it('prints a recorded status of any value, clipped to 40 characters', () => {
    const text = renderSearchResult(
      makeResult({
        hits: [makeHit(1, { status: 'x'.repeat(50) })],
      }),
    )
    expect(text).toContain(`Status: ${'x'.repeat(39)}…`)
  })
})

describe('renderSearchResult: 16 KB cap', () => {
  it('ends in the marker and stays within 16,384 bytes with 20 long hits', () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      makeHit(
        i + 1,
        {},
        {
          path: `docs/solutions/best-practices/${'p'.repeat(100)}-${i}.md`,
          title: 'é'.repeat(160),
          module: 'm'.repeat(120),
          tags: Array.from({ length: 8 }, (_, t) => `${'t'.repeat(60)}${t}`),
          body: `example ${'ü'.repeat(300)}`,
        },
      ),
    )
    const text = renderSearchResult(makeResult({ hits }))
    const bytes = new TextEncoder().encode(text)
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(MAX_OUTPUT_BYTES).toBe(16_384)
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(text).not.toContain('\ufffd')
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ).not.toThrow()
  })

  it('leaves small output alone', () => {
    expect(renderSearchResult(makeResult())).not.toContain(TRUNCATION_MARKER)
  })
})

// --- External results --------------------------------------------------

const BIDI = '\u202e'
const ZERO_WIDTH = '\u200b'

function makeRecord(overrides: Partial<ExternalRecord> = {}): ExternalRecord {
  return {
    source: 'wiki',
    origin: 'user',
    path: 'wiki/rfc/0001-cache.md',
    title: 'Cache decision',
    body: 'We decided on a cache layer for the example query.',
    ...overrides,
  }
}

function makeSection(
  overrides: Partial<ExternalSection> = {},
  records: readonly ExternalRecord[] = [makeRecord()],
): ExternalSection {
  return {
    name: 'wiki',
    origin: 'user',
    roots: ['/home/me/wiki'],
    state: 'loaded',
    recordCount: records.length,
    hits: records.map((record, index) => ({ rank: index + 1, record })),
    ...overrides,
  }
}

function makeExternalResult(
  overrides: Partial<ExternalSearchResult> = {},
): ExternalSearchResult {
  return {
    query: 'example query',
    queryTerms: ['example', 'query'],
    homeDir: '/home/me',
    project: { kind: 'none' },
    sections: [makeSection()],
    notes: [],
    warnings: [],
    ...overrides,
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

const FORBIDDEN_BUILTIN_TOKENS = [
  'Corpus:',
  'corpus: none',
  'corpus: empty',
  'Search "',
]

function expectNoBuiltinTokens(text: string): void {
  for (const token of FORBIDDEN_BUILTIN_TOKENS) {
    expect(text).not.toContain(token)
  }
  expect(text).not.toMatch(/\d+ docs?, \d+ hits?/)
}

describe('renderExternalResult', () => {
  it('starts with the external prefix and labels each section with name, origin and root', () => {
    const text = renderExternalResult(makeExternalResult())
    expect(text.startsWith('External sources for "example query":')).toBe(true)
    expect(text).toContain('wiki (user): ~/wiki')
    expect(text).toContain('1. wiki/rfc/0001-cache.md')
    expectNoBuiltinTokens(text)
  })

  it('labels a project source `project` and collapses only a root under the home directory', () => {
    const text = renderExternalResult(
      makeExternalResult({
        sections: [
          makeSection(
            {
              name: 'decisions',
              origin: 'project',
              roots: ['/repo/decisions'],
            },
            [makeRecord({ source: 'decisions', origin: 'project' })],
          ),
          makeSection({ name: 'home', roots: ['/home/me', '/home/meme/x'] }),
        ],
      }),
    )
    expect(text).toContain('decisions (project): /repo/decisions')
    expect(text).toContain('home (user): ~, /home/meme/x')
  })

  it('prints a recorded status when there is no node_type', () => {
    const text = renderExternalResult(
      makeExternalResult({
        sections: [makeSection({}, [makeRecord({ status: 'accepted' })])],
      }),
    )
    expect(text).toContain('Title: Cache decision | Status: accepted')
  })

  it('prints node_type in place of a status', () => {
    const text = renderExternalResult(
      makeExternalResult({
        sections: [
          makeSection({}, [
            makeRecord({ nodeType: 'decision', status: 'pending' }),
          ]),
        ],
      }),
    )
    expect(text).toContain('Title: Cache decision | node_type decision')
    expect(text).not.toContain('pending')
    expect(text).not.toContain('Status:')
  })

  it('prints no status at all when a record has neither', () => {
    const text = renderExternalResult(makeExternalResult())
    const titleLine = text.split('\n').find((line) => line.includes('Title:'))
    expect(titleLine?.trim()).toBe('Title: Cache decision')
  })

  it('shows a snippet window around the query terms', () => {
    const text = renderExternalResult(makeExternalResult())
    expect(text).toContain(
      'Snippet: We decided on a cache layer for the example query.',
    )
  })

  it('prints quiet states per source and still renders the others', () => {
    const text = renderExternalResult(
      makeExternalResult({
        sections: [
          makeSection({
            name: 'a-missing',
            state: 'missing',
            hits: [],
            recordCount: 0,
          }),
          makeSection({
            name: 'b-empty',
            state: 'empty',
            hits: [],
            recordCount: 0,
          }),
          makeSection({
            name: 'c-unreadable',
            state: 'unreadable',
            hits: [],
            recordCount: 0,
          }),
          makeSection({
            name: 'd-dropped',
            state: 'dropped',
            hits: [],
            recordCount: 0,
          }),
          makeSection({
            name: 'e-nohits',
            state: 'loaded',
            hits: [],
            recordCount: 7,
          }),
          makeSection({ name: 'f-live' }),
        ],
      }),
    )
    expect(text).toContain(
      'a-missing (user): ~/wiki\n   missing: root not found.',
    )
    expect(text).toContain(
      'b-empty (user): ~/wiki\n   empty: no readable records.',
    )
    expect(text).toContain(
      'c-unreadable (user): ~/wiki\n   unreadable: root could not be read.',
    )
    expect(text).toContain(
      'd-dropped (user): ~/wiki\n   dropped: see the warnings.',
    )
    expect(text).toContain('e-nohits (user): ~/wiki\n   No matching records.')
    expect(text).toContain('1. wiki/rfc/0001-cache.md')
    expect(
      text.startsWith(
        'External sources for "example query": 6 sources, 1 hit.',
      ),
    ).toBe(true)
  })

  it('prints notes, the project-level state line and bounded warnings in that order', () => {
    const text = renderExternalResult(
      makeExternalResult({
        notes: ['config unreadable'],
        project: { kind: 'not-allowed', proposals: 2, mainRoot: '/repo' },
        warnings: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'],
      }),
    )
    const lines = text.split('\n')
    expect(lines[1]).toBe('Notes: config unreadable')
    expect(lines[2]).toBe(
      'Project sources: 2 proposed sources not read: this project is not in search.allow_project_sources. To allow them, add "/repo" to search.allow_project_sources in your user config.',
    )
    expect(lines[3]).toBe('Warnings:')
    expect(lines.slice(4, 10)).toEqual([
      '- w1',
      '- w2',
      '- w3',
      '- w4',
      '- w5',
      '- +2 more',
    ])
  })

  it('names an unreadable project config without echoing anything from it', () => {
    const text = renderExternalResult(
      makeExternalResult({ project: { kind: 'config-unreadable' } }),
    )
    expect(text).toContain(
      'Project sources: the project config could not be read, so it proposes none.',
    )
  })

  it('shows the not-allowed line without a path when the identity is unresolved', () => {
    const text = renderExternalResult(
      makeExternalResult({ project: { kind: 'not-allowed', proposals: 1 } }),
    )
    expect(text).toContain(
      'Project sources: 1 proposed source not read: this project is not in search.allow_project_sources. Its identity could not be verified, so it cannot be allowed.',
    )
  })

  it('sanitizes and caps every echoed string', () => {
    const evil = `${ESC}[31mevil${ESC}]52;c;QUJD${BEL}${BIDI}${ZERO_WIDTH}name`
    const text = renderExternalResult(
      makeExternalResult({
        query: `q${ESC}[2J${BIDI}${NUL}uery ${'x'.repeat(400)}`,
        notes: [`note${ESC}[0m${BIDI}`],
        warnings: [`warn${ESC}[1m${BIDI}`],
        sections: [
          makeSection({ name: evil, roots: [`/r${ESC}[31m${BIDI}oot`] }, [
            makeRecord({
              path: `wiki/${evil}.md`,
              title: `${evil}${'t'.repeat(300)}`,
              status: `${evil}${'s'.repeat(80)}`,
              body: `example ${evil} query`,
            }),
          ]),
        ],
      }),
    )
    expect(hasControlCharacter(text)).toBe(false)
    expect(text).not.toContain(BIDI)
    expect(text).not.toContain(ZERO_WIDTH)
    expect(text).toContain(`Title: evil`)
    expect(text.split('\n')[0]?.length).toBeLessThanOrEqual(
      'External sources for "": 1 source, 1 hit.'.length + 200,
    )
    expect(text).toContain(`Status: evil`)
    expect(text).toContain(`${'t'.repeat(60)}`)
    expect(text).not.toContain('t'.repeat(300))
    expect(text).not.toContain('s'.repeat(80))
  })

  it('caps the title at 160 characters and the status at 40', () => {
    const text = renderExternalResult(
      makeExternalResult({
        sections: [
          makeSection({}, [
            makeRecord({ title: 't'.repeat(200), status: 's'.repeat(60) }),
          ]),
        ],
      }),
    )
    expect(text).toContain(`Title: ${'t'.repeat(159)}…`)
    expect(text).toContain(`Status: ${'s'.repeat(39)}…`)
  })
})

describe('renderExternalResult: the 12 KB allowance', () => {
  function bigRecords(source: string, count: number): ExternalRecord[] {
    return Array.from({ length: count }, (_, i) =>
      makeRecord({
        source,
        path: `${source}/${'p'.repeat(100)}-${i}.md`,
        title: 'é'.repeat(160),
        status: 'accepted',
        body: `example ${'ü'.repeat(400)}`,
      }),
    )
  }

  it('pins the allowance and its marker at 12 KB', () => {
    expect(EXTERNAL_MAX_OUTPUT_BYTES).toBe(12_288)
    expect(EXTERNAL_TRUNCATION_MARKER).toBe(
      '[Systematic: search output truncated at 12 KB]',
    )
  })

  it('no source takes all of the allowance, and a source past its share drops whole hits', () => {
    const sections = Array.from({ length: 8 }, (_, index) =>
      makeSection({ name: `src-${index}` }, bigRecords(`src-${index}`, 5)),
    )
    const text = renderExternalResult(makeExternalResult({ sections }))
    expect(byteLength(text)).toBeLessThanOrEqual(EXTERNAL_MAX_OUTPUT_BYTES)
    expect(text).not.toContain(EXTERNAL_TRUNCATION_MARKER)
    expect(text).not.toContain(TRUNCATION_MARKER)
    for (let index = 0; index < 8; index++) {
      expect(text).toContain(`src-${index} (user)`)
      // The top hit of every source survives.
      expect(text).toContain(`src-${index}/${'p'.repeat(100)}-0.md`)
    }
    const more = [...text.matchAll(/^\+(\d+) more hits not shown$/gm)]
    expect(more.length).toBeGreaterThan(0)
    // Whole hits are dropped: every printed hit is complete.
    const shown = [...text.matchAll(/^\d+\. src-/gm)].length
    const dropped = more.reduce((sum, match) => sum + Number(match[1]), 0)
    expect(shown + dropped).toBe(40)
  })

  it('splits evenly: a short source keeps all its hits next to a long one', () => {
    const text = renderExternalResult(
      makeExternalResult({
        sections: [
          makeSection({ name: 'big' }, bigRecords('big', 5)),
          makeSection({ name: 'small' }, [
            makeRecord({ source: 'small', path: 'small/a.md' }),
            makeRecord({ source: 'small', path: 'small/b.md' }),
          ]),
        ],
      }),
    )
    expect(text).toContain('2. small/b.md')
    expect(text).not.toContain('more hits not shown')
  })

  it('a truncated external reply carries the 12 KB marker and never the 16 KB one', () => {
    const text = renderExternalResult(
      makeExternalResult({
        notes: Array.from({ length: 80 }, (_, i) => `${'n'.repeat(190)}${i}`),
      }),
    )
    const bytes = new TextEncoder().encode(text)
    expect(bytes.byteLength).toBeLessThanOrEqual(EXTERNAL_MAX_OUTPUT_BYTES)
    expect(text.endsWith(EXTERNAL_TRUNCATION_MARKER)).toBe(true)
    expect(text).not.toContain(TRUNCATION_MARKER)
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ).not.toThrow()
  })

  it('leaves an in-budget reply without any marker', () => {
    const text = renderExternalResult(makeExternalResult())
    expect(text).not.toContain('truncated')
  })
})

describe('renderExternalFixedReply', () => {
  const quiet = { query: 'cache layer', notes: [], warnings: [] }

  it('pins the three fixed replies', () => {
    expect(renderExternalFixedReply({ kind: 'no-project' }, quiet)).toBe(
      'External sources for "cache layer": no project: there is no .git directory at or above the start directory, so there are no external sources to search.',
    )
    expect(renderExternalFixedReply({ kind: 'no-active-source' }, quiet)).toBe(
      'External sources for "cache layer": no external sources are active for this project.',
    )
  })

  it('pins the verified not-allowed variant: count and the exact main-root string', () => {
    expect(
      renderExternalFixedReply(
        { kind: 'not-allowed', proposals: 2, mainRoot: '/repo/main' },
        quiet,
      ),
    ).toBe(
      'External sources for "cache layer": this project proposes 2 external sources, but it is not in search.allow_project_sources, so nothing was read. To allow them, add "/repo/main" to search.allow_project_sources in your user config.',
    )
  })

  it('pins the unresolved not-allowed variant: the same reply with no path', () => {
    expect(
      renderExternalFixedReply({ kind: 'not-allowed', proposals: 1 }, quiet),
    ).toBe(
      'External sources for "cache layer": this project proposes 1 external source, but it is not in search.allow_project_sources, so nothing was read. Its identity could not be verified, so it cannot be allowed.',
    )
  })

  it('exports the templates and none of them carries a built-in routing token', () => {
    const samples = [
      EXTERNAL_REPLIES.noProject,
      EXTERNAL_REPLIES.noActiveSource,
      EXTERNAL_REPLIES.notAllowed(3, '/repo'),
      EXTERNAL_REPLIES.notAllowed(3),
    ]
    for (const sample of samples) expectNoBuiltinTokens(sample)
    for (const reply of [
      renderExternalFixedReply({ kind: 'no-project' }, quiet),
      renderExternalFixedReply({ kind: 'no-active-source' }, quiet),
      renderExternalFixedReply({ kind: 'not-allowed', proposals: 1 }, quiet),
    ]) {
      expect(reply.startsWith('External sources for "cache layer":')).toBe(true)
      expectNoBuiltinTokens(reply)
    }
  })

  it('never echoes source names or roots: the not-allowed reply takes no warnings', () => {
    const text = renderExternalFixedReply(
      { kind: 'not-allowed', proposals: 1, mainRoot: '/repo' },
      { ...quiet, warnings: ['secret-name: bad root /secret/root'] },
    )
    expect(text).not.toContain('secret')
  })

  it('adds notes, and for no-active-source the project state and warnings', () => {
    const text = renderExternalFixedReply(
      { kind: 'no-active-source' },
      {
        query: 'q',
        notes: ['config unreadable'],
        warnings: ['w1'],
        project: { kind: 'config-unreadable' },
      },
    )
    expect(text.split('\n')).toEqual([
      'External sources for "q": no external sources are active for this project.',
      'Notes: config unreadable',
      'Project sources: the project config could not be read, so it proposes none.',
      'Warnings:',
      '- w1',
    ])
  })

  it('sanitizes the query, the count and the main-root string, including a non-string query', () => {
    const evil = `${ESC}[31m${BIDI}q${NUL}${'x'.repeat(400)}`
    for (const reply of [
      renderExternalFixedReply(
        { kind: 'no-project' },
        { ...quiet, query: evil },
      ),
      renderExternalFixedReply(
        { kind: 'no-active-source' },
        { ...quiet, query: evil },
      ),
      renderExternalFixedReply(
        {
          kind: 'not-allowed',
          proposals: 1,
          mainRoot: `/r${ESC}[31m${BIDI}oot${'y'.repeat(600)}`,
        },
        { ...quiet, query: evil },
      ),
    ]) {
      expect(hasControlCharacter(reply)).toBe(false)
      expect(reply).not.toContain(BIDI)
      expect(reply).not.toContain('x'.repeat(400))
      expect(reply).not.toContain('y'.repeat(500))
    }
    for (const query of [undefined, null, 42, '', '   ']) {
      expect(
        renderExternalFixedReply(
          { kind: 'no-project' },
          { ...quiet, query },
        ).startsWith('External sources for "":'),
      ).toBe(true)
    }
  })
})
