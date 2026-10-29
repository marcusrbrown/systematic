import { describe, expect, it } from 'bun:test'
import type { CorpusDocument } from '../../src/lib/search-corpus.js'
import {
  extractSnippet,
  MAX_OUTPUT_BYTES,
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
    lanes: ['lexical'],
    status: 'active',
    lifecycle: [],
    ...overrides,
  }
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    query: 'example query',
    queryTerms: ['example', 'query'],
    corpus: { state: 'docs', docCount: 126 },
    lanes: ['lexical'],
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
        corpus: { state: 'none', docCount: 0 },
        lanes: [],
        hits: [],
      }),
    )
    const empty = renderSearchResult(
      makeResult({
        corpus: { state: 'empty', docCount: 0 },
        lanes: [],
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

  it('names the lanes that ran and counts the hits', () => {
    const text = renderSearchResult(
      makeResult({ hits: [makeHit(1), makeHit(2)], lanes: ['lexical'] }),
    )
    expect(text.split('\n')[0]).toBe(
      'Search "example query": 126 docs, 2 hits. Lanes: lexical. Corpus: docs/solutions.',
    )
    expect(
      renderSearchResult(
        makeResult({ corpus: { state: 'docs', docCount: 1 } }),
      ),
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
  it('shows path, title, kind, rank, lanes, status, module, tags and snippet', () => {
    const text = renderSearchResult(
      makeResult({
        hits: [
          makeHit(
            3,
            { lanes: ['lexical', 'semantic'], status: 'stale' },
            { body: 'the example query appears here' },
          ),
        ],
      }),
    )
    expect(text).toContain(
      '3. docs/solutions/best-practices/example-2026-08-16.md',
    )
    expect(text).toContain(
      'Title: Example title | Kind: solution | Status: stale | Lanes: lexical, semantic',
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
            lanes: [hostile('lane')] as SearchHit['lanes'],
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
