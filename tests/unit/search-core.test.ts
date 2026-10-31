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
} from '../../src/lib/search-core.js'
import {
  type CorpusLoad,
  type DocumentKind,
  KIND_TABLE,
  loadCorpus,
  MAX_FILE_BYTES,
  parseCorpusDocument,
} from '../../src/lib/search-corpus.js'
import {
  MAX_OUTPUT_BYTES,
  TRUNCATION_MARKER,
} from '../../src/lib/search-render.js'
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

function writeKindDoc(
  root: string,
  relative: string,
  frontmatter: string,
  body = 'Body text.',
): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `---\n${frontmatter}\n---\n\n${body}\n`)
}

function copyFixtureCorpus(
  name: 'lifecycle' | 'hostile' | 'past-work',
): string {
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

  it('searches plans, brainstorms and ideation end to end by kind', async () => {
    const root = copyFixtureCorpus('past-work')
    const plan = await search(root, 'alpha rollout quarantine', {
      kind: 'plan',
    })
    expect(pathsOf(plan)).toEqual([
      'docs/plans/2026-10-01-001-feat-alpha-plan.md',
    ])
    if (plan.ok) {
      expect(plan.result.hits[0]?.document).toMatchObject({
        kind: 'plan',
        title: 'feat: Alpha rollout',
      })
      expect(plan.text).toContain('Kind: plan')
    }

    const brainstorm = await search(root, 'foo', {
      kind: 'brainstorm',
    })
    expect(pathsOf(brainstorm)).toEqual([
      'docs/brainstorms/2026-10-01-topic-only-requirements.md',
    ])
    if (brainstorm.ok) {
      expect(brainstorm.result.hits[0]?.document.title).toBe('foo')
    }

    const ideation = await search(root, 'caching ideas', { kind: 'ideation' })
    expect(pathsOf(ideation)).toEqual([
      'docs/ideation/2026-10-01-open-ideation.md',
    ])
  })

  it('does not leak plans into a default solution search', async () => {
    const root = copyFixtureCorpus('past-work')
    const response = await search(root, 'alpha rollout quarantine')
    expect(pathsOf(response)).toEqual([])
  })

  it('reports a missing new-kind directory as an empty result, not an error', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha topic')
    const response = await search(root, 'alpha', { kind: 'brainstorm' })
    expect(response.ok).toBe(true)
    expect(pathsOf(response)).toEqual([])
    if (response.ok) expect(response.result.corpus.state).toBe('none')
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
    for (const kind of [
      'bogus',
      '',
      'Solution',
      'Plan',
      5,
      null,
      'ALL',
      'All',
      'all ',
      ' all',
      ['all'],
      ['plan'],
    ]) {
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
      expect(empty.result.corpus).toEqual({
        state: 'empty',
        docCount: 0,
        kinds: [
          {
            kind: 'solution',
            dir: 'docs/solutions',
            state: 'empty',
            docCount: 0,
          },
        ],
      })
      expect(zero.result.corpus).toEqual({
        state: 'docs',
        docCount: 2,
        kinds: [
          {
            kind: 'solution',
            dir: 'docs/solutions',
            state: 'docs',
            docCount: 2,
          },
        ],
      })
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
    expect(response.text).toContain(
      '- docs/solutions: skipped 7 files (7 invalid frontmatter)',
    )
    expect(response.text).not.toContain('bad-0.md')
    expect(response.text).not.toContain('more')
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

  it('resolves a superseded doc whose title ends in --- to its successor', async () => {
    const root = makeProject()
    writeDoc(
      root,
      'old.md',
      'title: Crash on start---\nstatus: superseded\nsuperseded_by: docs/solutions/new.md',
    )
    writeDoc(root, 'new.md', 'title: Startup fix with other words')
    const response = await search(root, 'crash on start')
    const paths = pathsOf(response)
    expect(paths).toEqual(['docs/solutions/new.md'])
    expect(response.text).toContain('Supersedes: docs/solutions/old.md')
    expect(response.text).not.toContain('status: superseded')
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

describe('runSearch: lifecycle across kinds', () => {
  it('replaces a superseded plan with its completed successor', async () => {
    const root = makeProject()
    writeKindDoc(
      root,
      'docs/plans/p1.md',
      'title: Quartz rollout\nstatus: superseded\nsuperseded_by: docs/plans/p2.md',
    )
    writeKindDoc(
      root,
      'docs/plans/p2.md',
      'title: Rollout, second attempt\nstatus: completed',
    )
    const response = await search(root, 'quartz', { kind: 'plan' })
    expect(pathsOf(response)).toEqual(['docs/plans/p2.md'])
    expect(response.text).toContain('Status: completed')
    expect(response.text).toContain('Supersedes: docs/plans/p1.md')
  })

  it('keeps a superseded plan visible when its successor is a solution', async () => {
    const root = makeProject()
    writeKindDoc(
      root,
      'docs/plans/p1.md',
      'title: Quartz rollout\nstatus: superseded\nsuperseded_by: docs/solutions/never-written.md',
    )
    const response = await search(root, 'quartz', { kind: 'plan' })
    expect(pathsOf(response)).toEqual(['docs/plans/p1.md'])
    expect(response.text).toContain('Status: superseded')
    expect(response.text).toContain(
      'Successor: docs/solutions/never-written.md',
    )
    expect(response.text).not.toContain('Caution:')
  })

  it('prints a Successor line for a solution superseded by a plan', async () => {
    const root = makeProject()
    writeDoc(
      root,
      'old.md',
      'title: Quartz fix\nstatus: superseded\nsuperseded_by: docs/plans/p.md',
    )
    const response = await search(root, 'quartz')
    expect(pathsOf(response)).toEqual(['docs/solutions/old.md'])
    expect(response.text).toContain('Successor: docs/plans/p.md')
    expect(response.text).not.toContain('Caution:')
  })

  it('prints recorded status raw for the new kinds and unspecified when absent', async () => {
    const root = makeProject()
    writeKindDoc(
      root,
      'docs/brainstorms/b.md',
      'topic: Quartz idea\nstatus: deferred',
    )
    writeKindDoc(root, 'docs/ideation/i.md', 'topic: Quartz survey')
    writeKindDoc(
      root,
      'docs/plans/p.md',
      'title: Quartz plan\nstatus: Completed',
    )
    const lines = async (kind: string) =>
      (await search(root, 'quartz', { kind })).text
        .split('\n')
        .filter((line) => line.includes('Status:'))
    expect(await lines('brainstorm')).toEqual([
      '   Title: Quartz idea | Kind: brainstorm | Status: deferred',
    ])
    expect(await lines('ideation')).toEqual([
      '   Title: Quartz survey | Kind: ideation | Status: unspecified',
    ])
    expect(await lines('plan')).toEqual([
      '   Title: Quartz plan | Kind: plan | Status: Completed',
    ])
  })

  it('still prints active for a solution with no status', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Quartz fix')
    expect((await search(root, 'quartz')).text).toContain('Status: active')
  })
})

describe('runSearch: lifecycle merges and the limit', () => {
  it('returns limit hits when many superseded docs share one successor, and lists every one under Supersedes:', async () => {
    const root = makeProject()
    const oldCount = 20
    for (let index = 0; index < oldCount; index += 1) {
      const name = String(index).padStart(2, '0')
      writeDoc(
        root,
        `old-${name}.md`,
        'title: Zeta zeta\nstatus: superseded\nsuperseded_by: docs/solutions/successor.md',
      )
    }
    writeDoc(root, 'successor.md', 'title: Successor with other words')
    for (let index = 0; index < 10; index += 1) {
      writeDoc(
        root,
        `active-${String(index).padStart(2, '0')}.md`,
        `title: Active ${index}`,
        'A body that mentions zeta once.',
      )
    }
    const response = await search(root, 'zeta', { limit: 8 })
    if (!response.ok) throw new Error(response.text)
    const { hits } = response.result
    expect(hits).toHaveLength(8)
    expect(hits[0]?.document.path).toBe('docs/solutions/successor.md')
    expect(new Set(hits.map((hit) => hit.document.path)).size).toBe(8)
    const supersedes = hits[0]?.lifecycle[0] ?? ''
    expect(supersedes.startsWith('Supersedes: ')).toBe(true)
    expect(supersedes.split(', ')).toHaveLength(oldCount)
    // The rendered text carries every predecessor in full, not only the
    // structured result: the line is longer than the 400-character cap.
    expect(supersedes.length).toBeGreaterThan(400)
    for (let index = 0; index < oldCount; index += 1) {
      const name = String(index).padStart(2, '0')
      expect(response.text).toContain(`docs/solutions/old-${name}.md`)
    }
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
    expect(response.text).toContain(
      'docs/solutions: skipped 2 files (2 invalid frontmatter)',
    )
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

describe('runSearch: output shape', () => {
  it('prints no Lanes segment on the summary line or any hit, and carries no lanes field', async () => {
    const root = makeProject()
    writeDoc(root, 'a.md', 'title: Alpha')
    const response = await search(root, 'alpha')
    if (!response.ok) throw new Error(response.text)
    expect(response.text).not.toContain('Lanes')
    expect(response.result).not.toHaveProperty('lanes')
    expect(response.result.hits[0]).not.toHaveProperty('lanes')
  })
})

describe('runSearch: the all selector', () => {
  function kindsOf(response: Awaited<ReturnType<typeof runSearch>>) {
    if (!response.ok) throw new Error(response.text)
    return response.result.hits.map((hit) => hit.document.kind)
  }

  it('leaves kind out as solutions only, and all adds every other kind (AE1)', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/solutions/s.md', 'title: Quartz fix')
    writeKindDoc(
      root,
      'docs/plans/p.md',
      'title: Quartz plan\nstatus: completed',
    )
    writeKindDoc(root, 'docs/brainstorms/b.md', 'topic: Quartz idea')
    writeKindDoc(root, 'docs/ideation/i.md', 'topic: Quartz survey')

    const omitted = await search(root, 'quartz')
    expect(pathsOf(omitted)).toEqual(['docs/solutions/s.md'])

    const all = await search(root, 'quartz', { kind: 'all' })
    expect(new Set(kindsOf(all))).toEqual(
      new Set<DocumentKind>(['solution', 'plan', 'brainstorm', 'ideation']),
    )
    expect(pathsOf(all)).toHaveLength(4)
    for (const kind of ['solution', 'plan', 'brainstorm', 'ideation']) {
      expect(all.text).toContain(`Kind: ${kind}`)
    }
  })

  it('searches plans with no docs/solutions/, and solution reports none (AE6)', async () => {
    const root = makeProject()
    for (const name of ['a', 'b', 'c']) {
      writeKindDoc(root, `docs/plans/${name}.md`, `title: Quartz ${name}`)
    }
    const all = await search(root, 'quartz', { kind: 'all' })
    expect(pathsOf(all)).toHaveLength(3)
    expect(all.text.split('\n')[0]).toBe(
      'Search "quartz": 3 docs, 3 hits. Corpus: solution none, plan 3, brainstorm none, ideation none.',
    )
    const solution = await search(root, 'quartz', { kind: 'solution' })
    expect(solution.text).toContain('corpus: none')
    expect(solution.text).toContain('docs/solutions/')
  })

  it('reads none only when every directory is absent, naming all four', async () => {
    const root = makeProject()
    const response = await search(root, 'quartz', { kind: 'all' })
    expect(response.text.split('\n')[0]).toBe(
      'Search "quartz": corpus: none (no docs/solutions/, docs/plans/, docs/brainstorms/ or docs/ideation/ directory under the project root).',
    )
    if (!response.ok) throw new Error(response.text)
    expect(response.result.corpus.state).toBe('none')
    expect(response.result.corpus.kinds.map((report) => report.state)).toEqual([
      'none',
      'none',
      'none',
      'none',
    ])
  })

  it('reads empty when directories exist but hold nothing indexable', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/plans/README.md', 'title: Index')
    fs.mkdirSync(path.join(root, 'docs/ideation'), { recursive: true })
    const response = await search(root, 'quartz', { kind: 'all' })
    expect(response.text.split('\n')[0]).toBe(
      'Search "quartz": corpus: empty (no indexable docs: solution none, plan empty, brainstorm none, ideation empty).',
    )
  })

  it('reads docs when one kind has documents and the other three are none', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/ideation/i.md', 'topic: Quartz survey')
    const response = await search(root, 'quartz', { kind: 'all' })
    expect(response.text.split('\n')[0]).toBe(
      'Search "quartz": 1 doc, 1 hit. Corpus: solution none, plan none, brainstorm none, ideation 1.',
    )
  })

  it('reports a count, none or empty for each kind', async () => {
    const root = makeProject()
    for (const name of ['a', 'b', 'c']) {
      writeKindDoc(root, `docs/solutions/${name}.md`, `title: Quartz ${name}`)
    }
    for (const name of ['a', 'b']) {
      writeKindDoc(root, `docs/plans/${name}.md`, `title: Quartz ${name}`)
    }
    fs.mkdirSync(path.join(root, 'docs/ideation'), { recursive: true })
    const response = await search(root, 'quartz', { kind: 'all' })
    expect(response.text.split('\n')[0]).toContain(
      'Corpus: solution 3, plan 2, brainstorm none, ideation empty.',
    )
  })

  it('accepts each table kind and the single-kind header names its directory', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/brainstorms/b.md', 'topic: Quartz idea')
    const response = await search(root, 'quartz', { kind: 'brainstorm' })
    expect(response.text.split('\n')[0]).toBe(
      'Search "quartz": 1 doc, 1 hit. Corpus: docs/brainstorms.',
    )
  })

  it('lists the kinds in table order, then all, in the fixed error, and keeps the limit error', async () => {
    const root = makeProject()
    expect(SEARCH_ERRORS.kindUnknown).toBe(
      'Error: kind must be one of: solution, plan, brainstorm, ideation, all.',
    )
    expect(await search(root, 'quartz', { limit: 21, kind: 'all' })).toEqual({
      ok: false,
      text: SEARCH_ERRORS.limitInvalid,
    })
  })

  it('calls the loader once per kind in table order, and merges in path order', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/solutions/z.md', 'title: Quartz z')
    writeKindDoc(root, 'docs/plans/a.md', 'title: Quartz a')
    writeKindDoc(root, 'docs/ideation/m.md', 'title: Quartz m')
    const calls: DocumentKind[] = []
    // Same text in every document, so equal scores fall to path order.
    const loader = (dir: string, kind: DocumentKind): CorpusLoad => {
      calls.push(kind)
      return loadCorpus(dir, kind)
    }
    const response = await search(
      root,
      'quartz',
      { kind: 'all' },
      { corpusLoader: loader },
    )
    expect(calls).toEqual(['solution', 'plan', 'brainstorm', 'ideation'])
    expect(pathsOf(response)).toEqual([
      'docs/ideation/m.md',
      'docs/plans/a.md',
      'docs/solutions/z.md',
    ])
    const again = await search(root, 'quartz', { kind: 'all' })
    expect(again.text).toBe(response.text)
  })

  it('calls the loader once for a single-kind search', async () => {
    const root = makeProject()
    const calls: DocumentKind[] = []
    await search(
      root,
      'quartz',
      { kind: 'plan' },
      {
        corpusLoader: (dir, kind) => {
          calls.push(kind)
          return loadCorpus(dir, kind)
        },
      },
    )
    expect(calls).toEqual(['plan'])
  })

  it('computes IDF over the merged documents', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/solutions/s1.md', 'title: Notes', 'alpha')
    writeKindDoc(root, 'docs/solutions/s2.md', 'title: Notes', 'beta')
    for (let index = 0; index < 12; index++) {
      writeKindDoc(
        root,
        `docs/plans/p${String(index).padStart(2, '0')}.md`,
        'title: Plan',
        'alpha',
      )
    }
    const solutionOnly = pathsOf(
      await search(root, 'alpha beta', { kind: 'solution' }),
    )
    expect(solutionOnly).toEqual([
      'docs/solutions/s1.md',
      'docs/solutions/s2.md',
    ])
    const merged = pathsOf(
      await search(root, 'alpha beta', { kind: 'all', limit: 20 }),
    )
    const solutions = merged.filter((hit) => hit.startsWith('docs/solutions/'))
    // Plans make "alpha" common, so the rare "beta" now outweighs it.
    expect(solutions).toEqual(['docs/solutions/s2.md', 'docs/solutions/s1.md'])
  })

  it('keeps the solution scores of a single-kind search when other kinds exist', async () => {
    const root = makeProject()
    writeKindDoc(root, 'docs/solutions/s1.md', 'title: Notes', 'alpha')
    writeKindDoc(root, 'docs/solutions/s2.md', 'title: Notes', 'beta')
    const before = (await search(root, 'alpha beta')).text
    for (let index = 0; index < 12; index++) {
      writeKindDoc(root, `docs/plans/p${index}.md`, 'title: Plan', 'alpha')
    }
    expect((await search(root, 'alpha beta')).text).toBe(before)
  })

  it('keeps all output within the 16 KB cap at limit 20, ending on the marker, never inside a hit line', async () => {
    const root = makeProject()
    const longName = (index: number) => `${'n'.repeat(180)}-${index}`
    const tags = Array.from(
      { length: 8 },
      (_, tag) => `${'t'.repeat(60)}${tag}`,
    )
    for (let index = 0; index < 20; index++) {
      writeKindDoc(
        root,
        `docs/solutions/${longName(index)}.md`,
        `title: ${'S'.repeat(150)}\nmodule: ${'m'.repeat(110)}\ntags: [${tags.join(', ')}]`,
        `needle ${'solution body words '.repeat(40)}`,
      )
      writeKindDoc(
        root,
        `docs/plans/${longName(index)}.md`,
        `title: ${'P'.repeat(150)}`,
        `needle ${'plan body words '.repeat(60)}`,
      )
    }
    const response = await search(root, 'needle', { kind: 'all', limit: 20 })
    if (!response.ok) throw new Error(response.text)
    expect(
      new TextEncoder().encode(response.text).byteLength,
    ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    const lines = response.text.split('\n')
    expect(lines.at(-1)).toBe(TRUNCATION_MARKER)

    const hitLines = lines.slice(1, -1)
    const pathLines = hitLines.filter((line) => /^\d+\. /.test(line))
    expect(pathLines.length).toBeGreaterThan(0)
    expect(pathLines.length).toBeLessThan(20)
    for (const line of pathLines) {
      expect(line).toMatch(/^\d+\. docs\/(solutions|plans)\/n+-\d+\.md$/)
    }
    // Bodies are identical within a kind, so a snippet cut short would show up
    // as a third variant.
    const snippets = new Set(
      hitLines.filter((line) => line.startsWith('   Snippet: ')),
    )
    expect(snippets.size).toBeLessThanOrEqual(2)
    for (const line of hitLines.filter((line) =>
      line.startsWith('   Title: '),
    )) {
      expect(line).toMatch(
        /^ {3}Title: ([SP])\1{149} \| Kind: (solution|plan) \| Status: (active|unspecified)$/,
      )
    }
  })
})

describe('runSearch: warnings per kind', () => {
  function plansLoader(
    skipped: number,
  ): (root: string, kind: DocumentKind) => CorpusLoad {
    return (_root, kind) => {
      if (kind === 'plan') {
        const parsed = parseCorpusDocument(
          'plan',
          'docs/plans/ok.md',
          'quartz\n',
        )
        if (!parsed.ok) throw new Error(parsed.reason)
        return {
          state: 'loaded',
          documents: [parsed.document],
          warnings: Array.from(
            { length: skipped },
            (_, index) =>
              `skipped docs/plans/bad-${index}.md: invalid frontmatter`,
          ),
        }
      }
      return { state: 'none', documents: [], warnings: [] }
    }
  }

  const warningLines = (text: string) =>
    text.split('\n').filter((line) => line.startsWith('- '))

  it('folds seven unparseable plans into one line with a count', async () => {
    const root = makeProject()
    const response = await search(
      root,
      'quartz',
      { kind: 'all' },
      { corpusLoader: plansLoader(7) },
    )
    expect(warningLines(response.text)).toEqual([
      '- docs/plans: skipped 7 files (7 invalid frontmatter)',
    ])
  })

  it('counts each reason and each kind, structural lines first', async () => {
    const root = makeProject()
    const loader = (_root: string, kind: DocumentKind): CorpusLoad => {
      if (kind === 'solution') {
        return {
          state: 'loaded',
          documents: [],
          warnings: [
            `skipped docs/solutions/a.md: larger than ${MAX_FILE_BYTES} bytes`,
            `skipped docs/solutions/b.md: larger than ${MAX_FILE_BYTES} bytes`,
            `skipped docs/solutions/c.md: larger than ${MAX_FILE_BYTES} bytes`,
            'skipped docs/solutions/d.md: invalid frontmatter',
            'docs/solutions: file limit of 2000 reached; skipped 12 files',
          ],
        }
      }
      if (kind === 'plan') {
        return {
          state: 'loaded',
          documents: [],
          warnings: [
            'skipped docs/plans/x.md: invalid frontmatter',
            'could not read directory docs/plans/locked',
          ],
        }
      }
      return { state: 'none', documents: [], warnings: [] }
    }
    const response = await search(
      root,
      'quartz',
      { kind: 'all' },
      { corpusLoader: loader },
    )
    expect(warningLines(response.text)).toEqual([
      '- docs/solutions: file limit of 2000 reached; skipped 12 files',
      '- could not read directory docs/plans/locked',
      `- docs/solutions: skipped 4 files (3 larger than ${MAX_FILE_BYTES} bytes, 1 invalid frontmatter)`,
      '- docs/plans: skipped 1 file (1 invalid frontmatter)',
    ])
  })

  it('keeps the five-line cap with a +N more line', async () => {
    const root = makeProject()
    const loader = (_root: string, kind: DocumentKind): CorpusLoad => ({
      state: 'loaded',
      documents: [],
      warnings: [
        `could not read directory ${KIND_TABLE[kind].dir}/a`,
        `could not read directory ${KIND_TABLE[kind].dir}/b`,
      ],
    })
    const response = await search(
      root,
      'quartz',
      { kind: 'all' },
      { corpusLoader: loader },
    )
    expect(warningLines(response.text)).toHaveLength(6)
    expect(warningLines(response.text).at(-1)).toBe('- +3 more')
  })

  it('names the directory in a real file-limit warning', async () => {
    const root = makeProject()
    for (let index = 0; index < 2001; index++) {
      writeKindDoc(
        root,
        `docs/plans/f${String(index).padStart(5, '0')}.md`,
        'title: Quartz',
      )
    }
    const response = await search(root, 'quartz', { kind: 'plan' })
    expect(response.text).toContain(
      '- docs/plans: file limit of 2000 reached; skipped 1 files',
    )
  })
})
