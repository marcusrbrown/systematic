import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  runSearch,
  SEARCH_ARGS,
  SEARCH_CONFIG_UNREADABLE_NOTE,
  SEARCH_ERRORS,
  SEARCH_TOOL_NAME,
  type SearchOptions,
  type SearchSettings,
  type SemanticStage,
} from '../../src/lib/search-core.js'
import { type CorpusLoad, loadCorpus } from '../../src/lib/search-corpus.js'
import { MAX_OUTPUT_BYTES } from '../../src/lib/search-render.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(ROOT_DIR, 'tests/fixtures/search-corpus')
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

/** A temp project root with a `.git` marker, so the walk-up stops here. */
function makeProject(): string {
  const root = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-core-'))),
  )
  fs.mkdirSync(path.join(root, '.git'))
  return root
}

function writeDoc(
  root: string,
  relative: string,
  frontmatter: string,
  body = 'Body text.',
): void {
  const target = path.join(root, 'docs/solutions', relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `---\n${frontmatter}\n---\n\n${body}\n`)
}

function copyFixtureCorpus(name: 'lifecycle' | 'hostile'): string {
  const root = makeProject()
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true })
  return root
}

function options(root: string, extra: Partial<SearchOptions> = {}) {
  return { startDir: root, ...extra }
}

async function search(
  root: string,
  query: unknown,
  extra: { kind?: unknown; limit?: unknown } = {},
  extraOptions: Partial<SearchOptions> = {},
) {
  return runSearch({ query, ...extra }, options(root, extraOptions))
}

function pathsOf(
  response: Awaited<ReturnType<typeof runSearch>>,
): readonly string[] {
  if (!response.ok) throw new Error(response.text)
  return response.result.hits.map((hit) => hit.document.path)
}

describe('tool constants', () => {
  it('names the tool and its arguments once', () => {
    expect(SEARCH_TOOL_NAME).toBe('systematic_search')
    expect(SEARCH_ARGS).toEqual({
      query: 'query',
      kind: 'kind',
      limit: 'limit',
    })
  })
})

describe('runSearch: ranking and hit shape', () => {
  it('ranks a title match first and fills every hit field', async () => {
    const root = makeProject()
    writeDoc(
      root,
      'best-practices/target.md',
      'title: Flaky websocket reconnect\ntags:\n  - networking\nmodule: transport\nstatus: active',
      'The reconnect loop backs off.',
    )
    writeDoc(
      root,
      'best-practices/other.md',
      'title: Unrelated topic',
      'A passing mention of websocket handling.',
    )
    const response = await search(root, 'websocket reconnect')
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const [first, second] = response.result.hits
    expect(first?.document.path).toBe('docs/solutions/best-practices/target.md')
    expect(second?.document.path).toBe('docs/solutions/best-practices/other.md')
    expect(first).toMatchObject({
      rank: 1,
      lanes: ['lexical'],
      status: 'active',
      lifecycle: [],
    })
    expect(first?.document).toMatchObject({
      title: 'Flaky websocket reconnect',
      kind: 'solution',
      module: 'transport',
      tags: ['networking'],
    })
    expect(second?.rank).toBe(2)
    expect(response.text).toContain(
      '1. docs/solutions/best-practices/target.md',
    )
    expect(response.text).toContain('Kind: solution')
    expect(response.text).toContain('Module: transport | Tags: networking')
    expect(response.result.lanes).toEqual(['lexical'])
  })

  it('surfaces a doc that matches only in its symptoms', async () => {
    const root = makeProject()
    writeDoc(
      root,
      'a.md',
      'title: Plain title\nsymptoms:\n  - build exits with a segfault on startup',
      'Nothing about it here.',
    )
    writeDoc(root, 'b.md', 'title: Another title', 'Nothing here either.')
    const response = await search(root, 'segfault on startup')
    expect(pathsOf(response)).toEqual(['docs/solutions/a.md'])
    if (response.ok)
      expect(response.text).toContain(
        'Snippet: build exits with a segfault on startup',
      )
  })

  it('accepts the solution kind and treats a missing kind the same way', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha topic')
    const withKind = await search(root, 'alpha', { kind: 'solution' })
    const without = await search(root, 'alpha')
    expect(withKind).toEqual(without)
    expect(pathsOf(withKind)).toEqual(['docs/solutions/a.md'])
  })

  it('applies a hit needs a score above zero', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha topic')
    expect(pathsOf(await search(root, 'zzzzunmatched'))).toEqual([])
    expect(pathsOf(await search(root, '!!! ???'))).toEqual([])
  })
})

describe('runSearch: limit', () => {
  async function manyDocs(): Promise<string> {
    const root = makeProject()
    for (let i = 0; i < 25; i++) {
      writeDoc(
        root,
        `doc-${String(i).padStart(2, '0')}.md`,
        `title: Gamma ${i}`,
      )
    }
    return root
  }

  it('defaults to 8 hits and honours 1 to 20', async () => {
    const root = await manyDocs()
    expect(DEFAULT_LIMIT).toBe(8)
    expect(pathsOf(await search(root, 'gamma'))).toHaveLength(8)
    expect(pathsOf(await search(root, 'gamma', { limit: 1 }))).toHaveLength(1)
    expect(
      pathsOf(await search(root, 'gamma', { limit: MAX_LIMIT })),
    ).toHaveLength(20)
  })

  it('rejects anything but an integer from 1 to 20, with no clamping', async () => {
    const root = await manyDocs()
    for (const limit of [
      0,
      21,
      2.5,
      -1,
      '5',
      'x',
      Number.NaN,
      null,
      true,
      {},
    ]) {
      const response = await search(root, 'gamma', { limit })
      expect(response).toEqual({ ok: false, text: SEARCH_ERRORS.limitInvalid })
    }
  })
})

describe('runSearch: validation', () => {
  it('returns fixed errors for a bad query or kind', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha')
    for (const query of ['', '   ', '\n\t', undefined, null, 5, ['a']]) {
      expect(await search(root, query)).toEqual({
        ok: false,
        text: SEARCH_ERRORS.queryEmpty,
      })
    }
    expect(await search(root, 'a'.repeat(2001))).toEqual({
      ok: false,
      text: SEARCH_ERRORS.queryTooLong,
    })
    expect((await search(root, 'a'.repeat(2000))).ok).toBe(true)
    for (const kind of ['plan', '', 'Solution', 5, null]) {
      expect(await search(root, 'alpha', { kind })).toEqual({
        ok: false,
        text: SEARCH_ERRORS.kindUnknown,
      })
    }
  })

  it('never echoes a rejected value', async () => {
    const root = makeProject()
    const response = await search(root, 'alpha', {
      kind: `${ESC}[31mevil`,
    })
    expect(response.text).not.toContain('evil')
    expect(response.text).not.toContain(ESC)
  })

  it('cuts a 70-term query to 64 terms and says so', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha')
    const query = Array.from({ length: 70 }, (_, i) => `term${i}`).join(' ')
    const response = await search(root, query)
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.result.queryTerms).toHaveLength(64)
    expect(response.result.notes).toEqual([
      'query cut to its first 64 distinct terms',
    ])
    expect(response.text).toContain(
      'Notes: query cut to its first 64 distinct terms',
    )
    const short = await search(root, 'alpha')
    if (short.ok) expect(short.result.notes).toEqual([])
  })

  it('shows adapter-supplied notes ahead of its own, in every corpus state', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha')
    const query = Array.from({ length: 70 }, (_, i) => `term${i}`).join(' ')
    const withDocs = await search(root, query, undefined, {
      notes: [SEARCH_CONFIG_UNREADABLE_NOTE],
    })
    expect(withDocs.ok).toBe(true)
    if (withDocs.ok) {
      expect(withDocs.result.notes).toEqual([
        'config unreadable',
        'query cut to its first 64 distinct terms',
      ])
    }
    const bare = await search(makeProject(), 'anything', undefined, {
      notes: [SEARCH_CONFIG_UNREADABLE_NOTE],
    })
    expect(bare.text).toContain('Notes: config unreadable')
  })
})

describe('runSearch: corpus states', () => {
  it('renders corpus none, empty and zero hits differently', async () => {
    const bare = makeProject()
    const none = await search(bare, 'anything')
    const emptyRoot = makeProject()
    fs.mkdirSync(path.join(emptyRoot, 'docs/solutions'), { recursive: true })
    fs.writeFileSync(path.join(emptyRoot, 'docs/solutions/README.md'), '# R\n')
    const empty = await search(emptyRoot, 'anything')
    const populated = makeProject()
    writeDoc(populated, 'a.md', 'title: Alpha')
    writeDoc(populated, 'b.md', 'title: Beta')
    const zero = await search(populated, 'zzzzunmatched')

    expect(none.text).toContain('corpus: none')
    expect(empty.text).toContain('corpus: empty')
    expect(zero.text).toContain('2 docs, 0 hits')
    expect(new Set([none.text, empty.text, zero.text]).size).toBe(3)
    if (none.ok && empty.ok && zero.ok) {
      expect(none.result.corpus.state).toBe('none')
      expect(empty.result.corpus).toEqual({ state: 'empty', docCount: 0 })
      expect(zero.result.corpus).toEqual({ state: 'docs', docCount: 2 })
      expect(none.result.hits).toEqual([])
    }
  })

  it('does not error with no docs/solutions/ and a project .git above the start dir', async () => {
    const root = makeProject()
    const nested = path.join(root, 'packages/app')
    fs.mkdirSync(nested, { recursive: true })
    writeDoc(root, 'a.md', 'title: Alpha topic')
    const response = await runSearch({ query: 'alpha' }, { startDir: nested })
    expect(pathsOf(response)).toEqual(['docs/solutions/a.md'])
  })

  it('reports load warnings and caps them', async () => {
    const root = makeProject()
    writeDoc(root, 'good.md', 'title: Good alpha')
    for (let i = 0; i < 7; i++) {
      const bad = path.join(root, 'docs/solutions', `bad-${i}.md`)
      fs.writeFileSync(bad, '---\ntitle: [unterminated\n---\nbody\n')
    }
    const response = await search(root, 'alpha')
    expect(response.text).toContain('Warnings:')
    expect(response.text).toContain('skipped docs/solutions/bad-0.md')
    expect(response.text).toContain('+2 more')
  })
})

describe('runSearch: lifecycle through the full pipeline', () => {
  it('replaces a superseded best match with its successor (AE3)', async () => {
    const root = copyFixtureCorpus('lifecycle')
    const response = await search(root, 'Chain A')
    const paths = pathsOf(response)
    expect(paths[0]).toBe('docs/solutions/lifecycle/chain-b.md')
    expect(paths).not.toContain('docs/solutions/lifecycle/chain-a.md')
    expect(response.text).toContain(
      'Supersedes: docs/solutions/lifecycle/chain-a.md',
    )
  })

  it('returns an unresolvable chain at its own rank with a caution (AE3)', async () => {
    const root = copyFixtureCorpus('lifecycle')
    const response = await search(root, 'Dangling successor')
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const [first] = response.result.hits
    expect(first?.document.path).toBe('docs/solutions/lifecycle/dangling.md')
    expect(first?.status).toBe('superseded')
    expect(first?.lifecycle).toEqual(['Caution: successor unresolved'])
    expect(response.text).toContain('Status: superseded')
    expect(response.text).toContain('Caution: successor unresolved')
    expect(response.text).not.toContain('Skipped:')
  })

  it('gives a stale hit a caution carrying its reason', async () => {
    const root = copyFixtureCorpus('lifecycle')
    const response = await search(root, 'Stale doc')
    expect(response.text).toContain(
      'Caution: marked stale: The retry budget was removed in 2026-09.',
    )
    expect(response.text).toContain('Status: stale')
  })

  it('merges two superseded matches into one successor entry', async () => {
    const root = copyFixtureCorpus('lifecycle')
    const response = await search(root, 'Merge A Merge B')
    const paths = pathsOf(response)
    expect(paths.filter((p) => p.endsWith('merge-successor.md'))).toHaveLength(
      1,
    )
    expect(response.text).toContain(
      'Supersedes: docs/solutions/lifecycle/merge-a.md, docs/solutions/lifecycle/merge-b.md',
    )
  })

  it('never prints Skipped: for any lifecycle fixture query', async () => {
    const root = copyFixtureCorpus('lifecycle')
    const response = await search(root, 'lifecycle-fixture', { limit: 20 })
    expect(response.text).not.toContain('Skipped:')
    expect(pathsOf(response).length).toBeGreaterThan(0)
  })

  it('keeps the result at the limit when merging collapses duplicates', async () => {
    const root = makeProject()
    writeDoc(
      root,
      'a.md',
      'title: Zeta zeta\nstatus: superseded\nsuperseded_by: docs/solutions/s.md',
    )
    writeDoc(
      root,
      'b.md',
      'title: Zeta zeta\nstatus: superseded\nsuperseded_by: docs/solutions/s.md',
    )
    writeDoc(root, 's.md', 'title: Successor with other words')
    writeDoc(root, 'c.md', 'title: Third', 'A body that mentions zeta once.')
    writeDoc(root, 'd.md', 'title: Fourth', 'A body that mentions zeta once.')
    const paths = pathsOf(await search(root, 'zeta', { limit: 2 }))
    expect(paths).toHaveLength(2)
    expect(paths[0]).toBe('docs/solutions/s.md')
    expect(new Set(paths).size).toBe(2)
  })
})

describe('runSearch: determinism and freshness', () => {
  it('gives identical text on repeat calls and under a shuffled load order', async () => {
    const root = copyFixtureCorpus('lifecycle')
    const first = await search(root, 'lifecycle-fixture chain stale', {
      limit: 20,
    })
    const second = await search(root, 'lifecycle-fixture chain stale', {
      limit: 20,
    })
    expect(second).toEqual(first)

    const shuffled = (load: CorpusLoad): CorpusLoad => ({
      ...load,
      documents: [...load.documents].reverse(),
    })
    const reversed = await search(
      root,
      'lifecycle-fixture chain stale',
      { limit: 20 },
      { corpusLoader: (r, kind) => shuffled(loadCorpus(r, kind)) },
    )
    expect(reversed.text).toBe(first.text)
  })

  it('breaks score ties on the code-unit path', async () => {
    const root = makeProject()
    for (const name of ['b.md', 'a.md', 'Z.md', 'c.md']) {
      writeDoc(root, name, 'title: Same title')
    }
    expect(pathsOf(await search(root, 'same title'))).toEqual([
      'docs/solutions/Z.md',
      'docs/solutions/a.md',
      'docs/solutions/b.md',
      'docs/solutions/c.md',
    ])
  })

  it('finds a doc written between two calls (no memo)', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha topic')
    expect(pathsOf(await search(root, 'omega'))).toEqual([])
    writeDoc(root, 'late.md', 'title: Omega just written')
    expect(pathsOf(await search(root, 'omega'))).toEqual([
      'docs/solutions/late.md',
    ])
  })
})

describe('runSearch: hostile content', () => {
  it('strips an ESC file name and an OSC 52 body from every surface of the text', async () => {
    const root = makeProject()
    const dir = path.join(root, 'docs/solutions')
    fs.mkdirSync(dir, { recursive: true })
    const evilName = `evil${ESC}[31m-name${ESC}]52;c;QUJD${BEL}.md`
    fs.writeFileSync(
      path.join(dir, evilName),
      `---\ntitle: Evil ${ESC}[1mtitle\ntags:\n  - "t${ESC}]52;c;WFla${BEL}ag"\nmodule: "mod${ESC}[0mule"\n---\n\nneedle line one ${ESC}]52;c;SGVsbG8=${BEL} needle after osc\n`,
    )
    fs.writeFileSync(
      path.join(dir, `bad${ESC}[2Jyaml.md`),
      '---\ntitle: [unterminated\n---\nbody\n',
    )
    const response = await search(root, `needle evil ${ESC}[31mquery`)
    expect(response.ok).toBe(true)
    expect(response.text).toContain('needle')
    expect(response.text).toContain('skipped docs/solutions/bad')
    expect(response.text).not.toContain(ESC)
    expect(response.text).not.toContain(BEL)
    expect(response.text).not.toContain('SGVsbG8')
    expect(response.text).not.toContain('QUJD')
    expect(response.text).not.toContain('WFla')
    expect(
      [...response.text].every(
        (c) => (c.codePointAt(0) ?? 0) >= 0x20 || c === '\n',
      ),
    ).toBe(true)
  })

  it('loads the hostile fixtures without crashing and without echoing control text', async () => {
    const root = copyFixtureCorpus('hostile')
    const response = await search(root, 'body survives cyclic alias nested')
    expect(response.ok).toBe(true)
    expect(response.text).not.toContain(ESC)
  })

  it('keeps 20 long hits within the byte cap', async () => {
    const root = makeProject()
    for (let i = 0; i < 20; i++) {
      writeDoc(
        root,
        `doc-${i}.md`,
        `title: ${'é'.repeat(200)}\nmodule: ${'m'.repeat(200)}\ntags: [${Array.from({ length: 12 }, (_, t) => `${'t'.repeat(80)}${t}`).join(', ')}]`,
        `needle ${'ü'.repeat(500)}`,
      )
    }
    const response = await search(root, 'needle', { limit: 20 })
    expect(
      new TextEncoder().encode(response.text).byteLength,
    ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(response.text).not.toContain('\ufffd')
  })
})

describe('runSearch: semantic stage seam', () => {
  const settings: SearchSettings = { enabled: true }

  it('reads lexical alone when no stage is injected', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha')
    const response = await search(root, 'alpha')
    if (!response.ok) throw new Error(response.text)
    expect(response.result.lanes).toEqual(['lexical'])
    expect(response.text).toContain('Lanes: lexical.')
  })

  it('lets an injected stage reorder, name lanes and add notes', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha one')
    writeDoc(root, 'b.md', 'title: Alpha two')
    let seen: Parameters<SemanticStage>[0] | undefined
    const stage: SemanticStage = async (input) => {
      seen = input
      return {
        ranked: [
          { id: 'docs/solutions/b.md', lanes: ['lexical', 'semantic'] },
          { id: 'docs/solutions/a.md', lanes: ['semantic'] },
        ],
        lanes: ['lexical', 'semantic'],
        notes: ['semantic index 2/2'],
      }
    }
    const response = await search(
      root,
      'alpha',
      {},
      { semantic: stage, settings },
    )
    if (!response.ok) throw new Error(response.text)
    expect(response.result.hits.map((h) => h.document.path)).toEqual([
      'docs/solutions/b.md',
      'docs/solutions/a.md',
    ])
    expect(response.result.hits.map((h) => h.lanes)).toEqual([
      ['lexical', 'semantic'],
      ['semantic'],
    ])
    expect(response.text).toContain('Lanes: lexical, semantic.')
    expect(response.text).toContain('Notes: semantic index 2/2')
    expect(seen?.settings).toBe(settings)
    expect(seen?.terms).toEqual(['alpha'])
    expect(seen?.documents).toHaveLength(2)
    expect(seen?.lexical).toHaveLength(2)
  })

  it('leaves the lexical result alone when the stage returns nothing', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha')
    const plain = await search(root, 'alpha')
    const withStage = await search(
      root,
      'alpha',
      {},
      { semantic: async () => undefined },
    )
    expect(withStage).toEqual(plain)
  })
})
