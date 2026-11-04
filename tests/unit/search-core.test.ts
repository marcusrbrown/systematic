import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_LIMIT,
  MAX_EXTERNAL_HITS_PER_SOURCE,
  MAX_LIMIT,
  rankExternalSources,
  runSearch,
  SEARCH_ARG_DESCRIPTIONS,
  SEARCH_ARGS,
  SEARCH_CONFIG_UNREADABLE_NOTE,
  SEARCH_ERRORS,
  SEARCH_TOOL_DESCRIPTION,
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
import type {
  ExternalRecord,
  SourceLoad,
} from '../../src/lib/search-external.js'
import type {
  ActiveSource,
  ExternalSourcesInput,
  ExternalSourcesResolution,
} from '../../src/lib/search-external-sources.js'
import {
  EXTERNAL_MAX_OUTPUT_BYTES,
  EXTERNAL_REPLIES,
  MAX_OUTPUT_BYTES,
  TRUNCATION_MARKER,
} from '../../src/lib/search-render.js'
import {
  type ExternalEnv,
  makeExternalEnv,
  userSource,
  writeMarkdown,
  writeProjectSearch,
  writeUserSearch,
} from '../helpers/search-external-env.js'
import { builtinResult } from '../helpers/search-response.js'
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
  return builtinResult(response).hits.map((hit) => hit.document.path)
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

describe('kind text', () => {
  it('names external beside all in the shared kind description', () => {
    expect(SEARCH_ARG_DESCRIPTIONS.kind).toContain('"all"')
    expect(SEARCH_ARG_DESCRIPTIONS.kind).toContain('"external"')
  })
})

describe('external limit and path text', () => {
  it('keeps the built-in limit wording and adds the per-source rule for external', () => {
    expect(SEARCH_ARG_DESCRIPTIONS.limit).toStartWith(
      'Optional. How many hits to return, an integer from 1 to 20. Defaults to 8.',
    )
    expect(SEARCH_ARG_DESCRIPTIONS.limit).toContain('"external"')
    expect(SEARCH_ARG_DESCRIPTIONS.limit).toContain('each source')
    expect(SEARCH_ARG_DESCRIPTIONS.limit).toContain('at most 5')
  })

  it('tells the model an external hit path is source-qualified and how to resolve it', () => {
    expect(SEARCH_TOOL_DESCRIPTION).toStartWith(
      "Search this project's durable outputs by symptom",
    )
    expect(SEARCH_TOOL_DESCRIPTION).toContain(
      'Use it before debugging a failure or planning work that a past learning, plan, brainstorm or ideation doc may already cover.',
    )
    const external = SEARCH_TOOL_DESCRIPTION.slice(
      SEARCH_TOOL_DESCRIPTION.indexOf('With kind external'),
    )
    expect(external).toContain('`<source>/<path>`')
    expect(external).toContain('Strip the source name')
    expect(external).toContain("inside one of that source's roots")
    expect(external).toContain('does not say which root')
    expect(external).toContain('first listed root that has it')
    // The path is not relative to the root as printed: the source name leads it.
    expect(external).not.toContain('relative to its source')
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
    const [first, second] = builtinResult(response).hits
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
      expect(builtinResult(plan).hits[0]?.document).toMatchObject({
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
      expect(builtinResult(brainstorm).hits[0]?.document.title).toBe('foo')
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
    expect(builtinResult(response).corpus.state).toBe('none')
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
    expect(builtinResult(response).queryTerms).toHaveLength(64)
    expect(builtinResult(response).notes).toEqual([
      'query cut to its first 64 distinct terms',
    ])
    expect(response.text).toContain(
      'Notes: query cut to its first 64 distinct terms',
    )
    const short = await search(root, 'alpha')
    expect(builtinResult(short).notes).toEqual([])
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
      expect(builtinResult(withDocs).notes).toEqual([
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
      expect(builtinResult(none).corpus.state).toBe('none')
      expect(builtinResult(empty).corpus).toEqual({
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
      expect(builtinResult(zero).corpus).toEqual({
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
      expect(builtinResult(none).hits).toEqual([])
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
    const [first] = builtinResult(response).hits
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
    const { hits } = builtinResult(response)
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
    expect(builtinResult(response)).not.toHaveProperty('lanes')
    expect(builtinResult(response).hits[0]).not.toHaveProperty('lanes')
  })
})

describe('runSearch: the all selector', () => {
  function kindsOf(response: Awaited<ReturnType<typeof runSearch>>) {
    if (!response.ok) throw new Error(response.text)
    return builtinResult(response).hits.map((hit) => hit.document.kind)
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
    expect(builtinResult(response).corpus.state).toBe('none')
    expect(
      builtinResult(response).corpus.kinds.map((report) => report.state),
    ).toEqual(['none', 'none', 'none', 'none'])
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
      'Error: kind must be one of: solution, plan, brainstorm, ideation, all, external.',
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

// --- kind: "external" --------------------------------------------------

const BIDI = '\u202e'
const ZERO_WIDTH = '\u200b'
const NUL = String.fromCharCode(0)

function hasControlOrInvisible(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return (
      (code <= 0x1f && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      character === BIDI ||
      character === ZERO_WIDTH
    )
  })
}

const FORBIDDEN_TOKENS = [
  'Corpus:',
  'corpus: none',
  'corpus: empty',
  'Search "',
]

function expectExternalShape(text: string): void {
  expect(text.startsWith('External sources for "')).toBe(true)
  for (const token of FORBIDDEN_TOKENS) expect(text).not.toContain(token)
  expect(text).not.toMatch(/\d+ docs?, \d+ hits?/)
}

function externalSearch(
  env: ExternalEnv,
  query: unknown,
  extra: { limit?: unknown } = {},
  extraOptions: Partial<SearchOptions> = {},
) {
  return runSearch(
    { query, kind: 'external', ...extra },
    {
      startDir: env.repo,
      configOptions: env.configOptions,
      ...extraOptions,
    },
  )
}

/** Sections in the order they print: `name (origin): root` lines. */
function sectionHeaders(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^[\w-]+ \((?:user|project)\): /.test(line))
}

describe('runSearch: kind external', () => {
  it('lists external in the fixed kind error', () => {
    expect(SEARCH_ERRORS.kindUnknown).toBe(
      'Error: kind must be one of: solution, plan, brainstorm, ideation, all, external.',
    )
  })

  it('is exclusive: it does not combine with a kind or all', async () => {
    const root = makeProject()
    for (const kind of [
      'external,plan',
      'plan,external',
      ' external',
      'External',
      ['external'],
    ]) {
      expect(await search(root, 'alpha', { kind })).toEqual({
        ok: false,
        text: SEARCH_ERRORS.kindUnknown,
      })
    }
  })

  it('each source appears in its own section and no source takes all of the output', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    const decisions = path.join(env.root, 'decisions')
    for (let index = 0; index < 48; index++) {
      writeMarkdown(wiki, `page-${String(index).padStart(2, '0')}.md`, {
        title: `Wiki page ${index}`,
        body: `The cache layer is described on page ${index}.`,
      })
    }
    for (let index = 0; index < 5; index++) {
      writeMarkdown(decisions, `adr-${index}.md`, {
        title: `Decision ${index} about the cache layer`,
        body: 'We settled the cache layer question.',
        status: 'accepted',
      })
    }
    writeUserSearch(env, {
      sources: [
        userSource(env, 'wiki', wiki),
        userSource(env, 'decisions', decisions),
      ],
    })

    const response = await externalSearch(env, 'cache layer', { limit: 20 })

    expect(response.ok).toBe(true)
    expectExternalShape(response.text)
    expect(sectionHeaders(response.text)).toEqual([
      `decisions (user): ${decisions}`,
      `wiki (user): ${wiki}`,
    ])
    const hitLines = response.text
      .split('\n')
      .filter((line) => /^\d+\. /.test(line))
    const decisionHits = hitLines.filter((line) => line.includes('decisions/'))
    const wikiHits = hitLines.filter((line) => line.includes('wiki/'))
    expect(decisionHits).toHaveLength(MAX_EXTERNAL_HITS_PER_SOURCE)
    expect(wikiHits).toHaveLength(MAX_EXTERNAL_HITS_PER_SOURCE)
    expect(response.text).toContain('Status: accepted')
    expect(
      new TextEncoder().encode(response.text).byteLength,
    ).toBeLessThanOrEqual(EXTERNAL_MAX_OUTPUT_BYTES)
  })

  it('caps limit at 5 per source and honors a smaller limit', async () => {
    const env = makeExternalEnv(temp)
    const notes = path.join(env.root, 'notes')
    for (let index = 0; index < 9; index++) {
      writeMarkdown(notes, `n${index}.md`, {
        title: `Note ${index}`,
        body: 'topic',
      })
    }
    writeUserSearch(env, { sources: [userSource(env, 'notes', notes)] })

    const high = await externalSearch(env, 'topic', { limit: 20 })
    const low = await externalSearch(env, 'topic', { limit: 2 })
    const unset = await externalSearch(env, 'topic')

    const count = (text: string) =>
      text.split('\n').filter((line) => /^\d+\. /.test(line)).length
    expect(count(high.text)).toBe(5)
    expect(count(low.text)).toBe(2)
    expect(count(unset.text)).toBe(5)
  })

  it('sorts sections by name in code-unit order and hits by rank then path, repeatably', async () => {
    const env = makeExternalEnv(temp)
    const names = ['b-src', 'A-src', 'a-src']
    const sources = names.map((name) => {
      const dir = path.join(env.root, name)
      // Equal text everywhere, so equal scores fall to path order.
      for (const file of ['z.md', 'a.md', 'm.md']) {
        writeMarkdown(dir, file, {
          title: 'Same title',
          body: 'same body zebra',
        })
      }
      return userSource(env, name, dir)
    })
    writeUserSearch(env, { sources })

    const first = await externalSearch(env, 'zebra')
    const second = await externalSearch(env, 'zebra')

    expect(second.text).toBe(first.text)
    expect(
      sectionHeaders(first.text).map((line) => line.split(' ')[0]),
    ).toEqual(['A-src', 'a-src', 'b-src'])
    const paths = first.text
      .split('\n')
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => line.replace(/^\d+\. /, ''))
    expect(paths.slice(0, 3)).toEqual([
      'A-src/a.md',
      'A-src/m.md',
      'A-src/z.md',
    ])
  })

  it('labels a project source and a user source by origin', async () => {
    const env = makeExternalEnv(temp)
    const adrs = path.join(env.repo, 'docs/adrs')
    writeMarkdown(adrs, 'one.md', { title: 'ADR one', body: 'queue decision' })
    const runbooks = path.join(env.root, 'runbooks')
    writeMarkdown(runbooks, 'one.md', {
      title: 'Runbook one',
      body: 'queue restart',
    })
    writeProjectSearch(env, {
      sources: [{ name: 'adrs', format: 'markdown', roots: ['docs/adrs'] }],
    })
    writeUserSearch(env, {
      allow_project_sources: [env.repo],
      sources: [userSource(env, 'runbooks', runbooks)],
    })

    const response = await externalSearch(env, 'queue')

    expect(sectionHeaders(response.text)).toEqual([
      `adrs (project): ${adrs}`,
      `runbooks (user): ${runbooks}`,
    ])
  })

  it('collapses the home directory to ~ in a section header', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.homeDir, 'wiki')
    writeMarkdown(wiki, 'a.md', { title: 'A', body: 'needle' })
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
    const response = await externalSearch(env, 'needle')
    expect(sectionHeaders(response.text)).toEqual(['wiki (user): ~/wiki'])
  })

  it('prints quiet states for a missing root and an empty source, and still renders the others', async () => {
    const env = makeExternalEnv(temp)
    const live = path.join(env.root, 'live')
    writeMarkdown(live, 'a.md', { title: 'Alive', body: 'needle' })
    const empty = path.join(env.root, 'empty')
    fs.mkdirSync(empty)
    writeUserSearch(env, {
      sources: [
        userSource(env, 'gone', path.join(env.root, 'no-such-dir')),
        userSource(env, 'empty', empty),
        userSource(env, 'live', live),
      ],
    })

    const response = await externalSearch(env, 'needle')

    expect(response.ok).toBe(true)
    expect(response.text).toContain('\n   missing: root not found.')
    expect(response.text).toContain('\n   empty: no readable records.')
    expect(response.text).toContain('1. live/a.md')
    expect(response.text.split('\n')[0]).toBe(
      'External sources for "needle": 3 sources, 1 hit.',
    )
  })

  it('prints an unreadable root as a quiet state', async () => {
    if (process.getuid?.() === 0) return
    const env = makeExternalEnv(temp)
    const locked = path.join(env.root, 'locked')
    writeMarkdown(locked, 'a.md', { title: 'A', body: 'needle' })
    writeUserSearch(env, { sources: [userSource(env, 'locked', locked)] })
    fs.chmodSync(locked, 0)
    try {
      const response = await externalSearch(env, 'needle')
      expect(response.text).toContain(
        '\n   unreadable: root could not be read.',
      )
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })

  it('lists the warning of a dropped source before other warnings', async () => {
    const env = makeExternalEnv(temp)
    const outside = path.join(env.root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(env.repo, 'linked'))
    const big = path.join(env.root, 'big')
    writeMarkdown(big, 'ok.md', { title: 'Fine', body: 'needle' })
    fs.writeFileSync(
      path.join(big, 'huge.md'),
      `needle ${'x'.repeat(1024 * 1024 + 8)}`,
    )
    writeProjectSearch(env, {
      sources: [{ name: 'linked', format: 'markdown', roots: ['linked'] }],
    })
    writeUserSearch(env, {
      allow_project_sources: [env.repo],
      sources: [userSource(env, 'big', big)],
    })

    const response = await externalSearch(env, 'needle')

    const warnings = response.text
      .split('\n')
      .filter((line) => line.startsWith('- '))
    expect(warnings[0]).toContain('linked: a project root is a symlink')
    expect(warnings.some((line) => line.includes('skipped big/huge.md'))).toBe(
      true,
    )
    expect(response.text).toContain('linked (project)')
    expect(response.text).toContain('\n   dropped: see the warnings.')
  })

  it('no active source returns the fixed ok reply; a missing declared root is still active', async () => {
    const env = makeExternalEnv(temp)
    const none = await externalSearch(env, 'anything')
    expect(none).toMatchObject({ ok: true })
    expect(none.text).toBe(
      `External sources for "anything": ${EXTERNAL_REPLIES.noActiveSource}`,
    )

    writeUserSearch(env, {
      sources: [userSource(env, 'gone', path.join(env.root, 'nope'))],
    })
    const missing = await externalSearch(env, 'anything')
    expect(missing.ok).toBe(true)
    expect(missing.text).not.toContain(EXTERNAL_REPLIES.noActiveSource)
    expect(missing.text).toContain('gone (user)')
    expect(missing.text).toContain('missing: root not found.')
  })

  it('a project that proposes sources but is not allowed gets the fixed reply with the count and the main root and no names or roots', async () => {
    const env = makeExternalEnv(temp)
    writeProjectSearch(env, {
      sources: [
        {
          name: 'secret-name',
          format: 'markdown',
          roots: ['docs/secret-root'],
        },
        { name: 'other', format: 'markdown', roots: ['docs/other-root'] },
      ],
    })
    const response = await externalSearch(env, 'anything')
    expect(response.ok).toBe(true)
    expect(response.text).toBe(
      `External sources for "anything": ${EXTERNAL_REPLIES.notAllowed(2, env.repo)}`,
    )
    expect(response.text).toContain(`add "${env.repo}"`)
    expect(response.text).not.toContain('secret')
    expect(response.text).not.toContain('other')
  })

  it('with another active source the not-allowed state is a project-level line instead', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    writeMarkdown(wiki, 'a.md', { title: 'A', body: 'needle' })
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
    writeProjectSearch(env, {
      sources: [
        { name: 'secret-name', format: 'markdown', roots: ['docs/secret'] },
      ],
    })
    const response = await externalSearch(env, 'needle')
    expect(response.text).toContain('wiki (user)')
    expect(response.text).toContain(
      `Project sources: 1 proposed source not read: this project is not in search.allow_project_sources. To allow it, add "${env.repo}" to search.allow_project_sources in your user config.`,
    )
    expect(response.text).not.toContain('secret')
  })

  it('an unresolved identity gets the not-allowed reply with no path', async () => {
    const env = makeExternalEnv(temp)
    // A `.git` file that points nowhere: the checkout root is found, the identity is not.
    fs.rmSync(path.join(env.repo, '.git'), { recursive: true })
    fs.writeFileSync(path.join(env.repo, '.git'), 'not a gitdir pointer\n')
    writeProjectSearch(env, {
      sources: [{ name: 'adrs', format: 'markdown', roots: ['docs/adrs'] }],
    })
    writeUserSearch(env, { allow_project_sources: [env.repo] })

    const response = await externalSearch(env, 'anything')

    expect(response.text).toBe(
      `External sources for "anything": ${EXTERNAL_REPLIES.notAllowed(1)}`,
    )
    expect(response.text).not.toContain(env.repo)
  })

  it('a project config with a structural error reports it without proposing anything', async () => {
    const env = makeExternalEnv(temp)
    fs.mkdirSync(path.join(env.repo, '.opencode'))
    fs.writeFileSync(
      path.join(env.repo, '.opencode/systematic.json'),
      '{ not json',
    )
    const response = await externalSearch(env, 'anything')
    expect(response.text).toContain(EXTERNAL_REPLIES.noActiveSource)
    expect(response.text).toContain(
      'Project sources: the project config could not be read, so it proposes none.',
    )
  })

  describe('precedence', () => {
    it('no project beats an empty query and a bad limit', async () => {
      const bare = temp.track(
        fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'search-noproj-')),
        ),
      )
      const env = makeExternalEnv(temp)
      for (const request of [
        { query: '', kind: 'external' },
        { query: 42, kind: 'external', limit: 0 },
        { query: 'alpha', kind: 'external', limit: 99 },
      ]) {
        const response = await runSearch(request, {
          startDir: bare,
          configOptions: env.configOptions,
        })
        expect(response.ok).toBe(true)
        expect(response.text).toBe(
          `External sources for "${typeof request.query === 'string' ? request.query : ''}": ${EXTERNAL_REPLIES.noProject}`,
        )
      }
    })

    it('a project with an empty query gives the core validation error, whatever the sources say', async () => {
      const env = makeExternalEnv(temp)
      writeProjectSearch(env, {
        sources: [{ name: 'adrs', format: 'markdown', roots: ['docs/adrs'] }],
      })
      expect(await externalSearch(env, '')).toEqual({
        ok: false,
        text: SEARCH_ERRORS.queryEmpty,
      })
      expect(await externalSearch(env, 'alpha', { limit: 21 })).toEqual({
        ok: false,
        text: SEARCH_ERRORS.limitInvalid,
      })
    })

    it('built-in kinds keep their order: query, then kind, then limit, with or without a project', async () => {
      const bare = temp.track(
        fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'search-noproj-')),
        ),
      )
      expect(
        await runSearch({ query: '', kind: 'bogus' }, { startDir: bare }),
      ).toEqual({ ok: false, text: SEARCH_ERRORS.queryEmpty })
    })

    it('with a project and a valid query, per-source states render', async () => {
      const env = makeExternalEnv(temp)
      writeUserSearch(env, {
        sources: [userSource(env, 'gone', path.join(env.root, 'nope'))],
      })
      const response = await externalSearch(env, 'alpha')
      expect(response.text).toContain('missing: root not found.')
    })
  })

  describe('sanitization', () => {
    const evil = `${ESC}[31mevil${ESC}]52;c;QUJD${BEL}${BIDI}${ZERO_WIDTH}${NUL}`

    it('sanitizes and caps the echoed query in every reply, including those produced before validation', async () => {
      const bare = temp.track(
        fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'search-noproj-')),
        ),
      )
      const env = makeExternalEnv(temp)
      const query = `${evil}q ${'x'.repeat(500)}`

      const noProject = await runSearch(
        { query, kind: 'external' },
        { startDir: bare, configOptions: env.configOptions },
      )
      writeProjectSearch(env, {
        sources: [{ name: 'adrs', format: 'markdown', roots: ['docs/adrs'] }],
      })
      const notAllowed = await externalSearch(env, query)
      fs.rmSync(path.join(env.repo, '.opencode'), { recursive: true })
      const noActive = await externalSearch(env, query)

      for (const response of [noProject, notAllowed, noActive]) {
        expect(response.ok).toBe(true)
        expect(hasControlOrInvisible(response.text)).toBe(false)
        expect(response.text).not.toContain('x'.repeat(250))
      }
    })

    it('sanitizes source names, roots and titles in a result', async () => {
      const env = makeExternalEnv(temp)
      const dir = path.join(env.root, `dir${ESC}[31m${BIDI}name`)
      writeMarkdown(dir, 'a.md', {
        title: `'${evil}${'t'.repeat(300)}'`,
        body: `needle ${evil} body`,
        status: `'${evil}'`,
      })
      writeUserSearch(env, { sources: [userSource(env, 'good-name', dir)] })

      const response = await externalSearch(env, `needle ${evil}`)

      expect(response.ok).toBe(true)
      expect(hasControlOrInvisible(response.text)).toBe(false)
      expect(response.text).not.toContain('t'.repeat(200))
    })
  })

  describe('hit paths with several roots', () => {
    it('shows a hit from the second root as <source>/<path>, with both roots in the header and no mark of which root', async () => {
      const env = makeExternalEnv(temp)
      const one = path.join(env.root, 'wiki-one')
      const two = path.join(env.root, 'wiki-two')
      writeMarkdown(one, 'a.md', { title: 'Only in one', body: 'needle' })
      writeMarkdown(two, 'b.md', { title: 'Only in two', body: 'needle' })
      writeMarkdown(one, 'dup.md', { title: 'Dup from one', body: 'needle' })
      writeMarkdown(two, 'dup.md', { title: 'Dup from two', body: 'needle' })
      writeUserSearch(env, {
        sources: [
          {
            name: 'wiki',
            format: 'markdown',
            roots: [one, two],
            projects: [env.repo],
          },
        ],
      })

      const response = await externalSearch(env, 'needle')
      const lines = response.text.split('\n')

      expect(sectionHeaders(response.text)).toEqual([
        `wiki (user): ${one}, ${two}`,
      ])
      expect(lines).toContain('1. wiki/a.md')
      expect(lines.some((line) => /^\d+\. wiki\/b\.md$/.test(line))).toBe(true)
      // The path names the source, not the root, and no hit line says which root.
      for (const line of lines.filter((l) => /^\d+\. /.test(l))) {
        expect(line).not.toContain(one)
        expect(line).not.toContain(two)
      }
      // The first listed root that has a path provides it.
      expect(response.text).toContain('Title: Dup from one')
      expect(response.text).not.toContain('Dup from two')
    })
  })

  describe('notes', () => {
    it('prints a registration-time note and a per-call one once, and a repair clears only the per-call part', async () => {
      const env = makeExternalEnv(temp)
      writeUserSearch(env, '{ broken')
      const options = { notes: [SEARCH_CONFIG_UNREADABLE_NOTE] }

      const broken = await externalSearch(env, 'alpha', {}, options)
      expect(
        broken.text.split('\n').filter((line) => line.startsWith('Notes:')),
      ).toEqual(['Notes: config unreadable'])

      writeUserSearch(env, {})
      const repaired = await externalSearch(env, 'alpha', {}, options)
      expect(repaired.text).toContain('Notes: config unreadable')

      const repairedNoRegistration = await externalSearch(env, 'alpha')
      expect(repairedNoRegistration.text).not.toContain('Notes:')
    })

    it('a per-call failure alone adds the note, with the external call still run', async () => {
      const env = makeExternalEnv(temp)
      writeUserSearch(env, '{ broken')
      const response = await externalSearch(env, 'alpha')
      expect(response.ok).toBe(true)
      expect(response.text).toContain('Notes: config unreadable')
      expect(response.text).toContain(EXTERNAL_REPLIES.noActiveSource)
    })

    it('the query-cut note rides in the results', async () => {
      const env = makeExternalEnv(temp)
      const wiki = path.join(env.root, 'wiki')
      writeMarkdown(wiki, 'a.md', { title: 'A', body: 'term0' })
      writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
      const query = Array.from({ length: 65 }, (_, i) => `term${i}`).join(' ')
      const response = await externalSearch(env, query)
      expect(response.text).toContain(
        'Notes: query cut to its first 64 distinct terms',
      )
    })
  })

  describe('the external-resolver seam and the config-dir option', () => {
    function resolution(
      overrides: Partial<ExternalSourcesResolution> = {},
    ): ExternalSourcesResolution {
      return {
        sources: [],
        project: { kind: 'none' },
        userConfigUnreadable: false,
        warnings: [],
        ...overrides,
      }
    }

    it('hands the resolver the start directory and the config-dir option unchanged', async () => {
      const env = makeExternalEnv(temp)
      const seen: ExternalSourcesInput[] = []
      await externalSearch(
        env,
        'alpha',
        {},
        {
          externalResolver: (input) => {
            seen.push(input)
            return resolution()
          },
        },
      )
      expect(seen).toEqual([
        { startDir: env.repo, configOptions: env.configOptions },
      ])
    })

    it('a config-dir override changes which allow list is read', async () => {
      const env = makeExternalEnv(temp)
      const adrs = path.join(env.repo, 'docs/adrs')
      writeMarkdown(adrs, 'a.md', { title: 'ADR', body: 'needle' })
      writeProjectSearch(env, {
        sources: [{ name: 'adrs', format: 'markdown', roots: ['docs/adrs'] }],
      })
      writeUserSearch(env, {})
      const custom = path.join(env.root, 'custom-config')
      fs.mkdirSync(custom)
      fs.writeFileSync(
        path.join(custom, 'systematic.json'),
        JSON.stringify({ search: { allow_project_sources: [env.repo] } }),
      )

      const withoutCustom = await externalSearch(env, 'needle')
      const withCustom = await externalSearch(
        env,
        'needle',
        {},
        {
          configOptions: { ...env.configOptions, customConfigDir: custom },
        },
      )

      expect(withoutCustom.text).toContain(
        'not in search.allow_project_sources',
      )
      expect(withCustom.text).toContain('adrs (project)')
      expect(withCustom.text).toContain('1. adrs/a.md')
    })

    it('a resolver that throws is an unexpected failure and rejects', async () => {
      const env = makeExternalEnv(temp)
      await expect(
        externalSearch(
          env,
          'alpha',
          {},
          {
            externalResolver: () => {
              throw new Error('boom')
            },
          },
        ),
      ).rejects.toThrow('boom')
    })

    it('uses the resolver result: a source it returns is loaded and ranked', async () => {
      const env = makeExternalEnv(temp)
      const dir = path.join(env.root, 'injected')
      writeMarkdown(dir, 'a.md', { title: 'Injected', body: 'needle' })
      const source: ActiveSource = {
        name: 'injected',
        format: 'markdown',
        roots: [dir],
        origin: 'user',
        exclude: [],
      }
      const response = await externalSearch(
        env,
        'needle',
        {},
        {
          externalResolver: () => resolution({ sources: [source] }),
        },
      )
      expect(response.text).toContain('1. injected/a.md')
    })
  })

  it('never returns a built-in routing token or a built-in section', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    writeMarkdown(wiki, 'a.md', { title: 'A', body: 'needle' })
    writeKindDoc(env.repo, 'docs/solutions/a.md', 'title: needle solution')
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
    for (const query of ['needle', 'zzzz-no-hit']) {
      const response = await externalSearch(env, query)
      expectExternalShape(response.text)
      expect(response.text).not.toContain('docs/solutions')
    }
  })

  it('is deterministic across repeated calls', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    for (let index = 0; index < 12; index++) {
      writeMarkdown(wiki, `p${index}.md`, {
        title: `Page ${index}`,
        body: 'needle haystack',
      })
    }
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
    const first = await externalSearch(env, 'needle haystack')
    for (let round = 0; round < 3; round++) {
      expect((await externalSearch(env, 'needle haystack')).text).toBe(
        first.text,
      )
    }
  })

  it('hands the structured result back beside the text, narrowed on the selector', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    writeMarkdown(wiki, 'a.md', { title: 'A', body: 'needle' })
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
    const response = await externalSearch(env, 'needle')
    if (!response.ok || response.selector !== 'external') {
      throw new Error(response.text)
    }
    if (response.external.kind !== 'sections') {
      throw new Error('expected sections')
    }
    expect(
      response.external.result.sections.map((section) => section.name),
    ).toEqual(['wiki'])
    expect(response.external.result.sections[0]?.hits).toHaveLength(1)
  })
})

describe('rankExternalSources', () => {
  function record(overrides: Partial<ExternalRecord>): ExternalRecord {
    return {
      source: 'graph',
      origin: 'user',
      path: 'graph/nodes/a.json',
      title: 'Untitled',
      body: '',
      ...overrides,
    }
  }

  function entry(records: ExternalRecord[], name = 'graph') {
    const source: ActiveSource = {
      name,
      format: 'markdown',
      roots: ['/r'],
      origin: 'user',
      exclude: [],
    }
    const load: SourceLoad = {
      name,
      origin: 'user',
      state: records.length === 0 ? 'empty' : 'loaded',
      records,
      warnings: [],
    }
    return { source, load }
  }

  function ranked(records: ExternalRecord[], terms: string[]): string[] {
    const [section] = rankExternalSources([entry(records)], terms, 5)
    return section?.hits.map((hit) => hit.record.path) ?? []
  }

  it('maps node_type to tags: a record whose only match is node_type outranks one with no match', () => {
    const order = ranked(
      [
        record({
          path: 'graph/nodes/a.json',
          title: 'alpha',
          body: 'nothing here',
        }),
        record({
          path: 'graph/nodes/b.json',
          title: 'beta',
          body: 'nothing here',
          nodeType: 'decision',
        }),
      ],
      ['decision'],
    )
    expect(order).toEqual(['graph/nodes/b.json'])
  })

  it('maps title above body: the same term in the title outranks it in the body', () => {
    const order = ranked(
      [
        record({
          path: 'graph/nodes/body.json',
          title: 'other',
          body: 'queue',
        }),
        record({
          path: 'graph/nodes/title.json',
          title: 'queue',
          body: 'other',
        }),
      ],
      ['queue'],
    )
    expect(order).toEqual(['graph/nodes/title.json', 'graph/nodes/body.json'])
  })

  it('ranks tags (node_type) above body', () => {
    const order = ranked(
      [
        record({ path: 'graph/nodes/body.json', title: 'x', body: 'outcome' }),
        record({
          path: 'graph/nodes/tag.json',
          title: 'x',
          body: 'y',
          nodeType: 'outcome',
        }),
      ],
      ['outcome'],
    )
    expect(order).toEqual(['graph/nodes/tag.json', 'graph/nodes/body.json'])
  })

  it('scores each source against its own index, not a shared one', () => {
    const common = record({ path: 'one/a.md', title: 'rare', body: 'rare' })
    const [first, second] = rankExternalSources(
      [
        entry(
          [
            common,
            ...Array.from({ length: 30 }, (_, i) =>
              record({ path: `one/f${i}.md`, title: 'filler', body: 'filler' }),
            ),
          ],
          'one',
        ),
        entry(
          [record({ path: 'two/a.md', title: 'rare', body: 'rare' })],
          'two',
        ),
      ],
      ['rare'],
      5,
    )
    expect(first?.hits.map((hit) => hit.record.path)).toEqual(['one/a.md'])
    expect(second?.hits.map((hit) => hit.record.path)).toEqual(['two/a.md'])
  })

  it('does not let another source change the order inside a source (length normalisation is per index)', () => {
    const filler = (count: number) =>
      Array.from({ length: count }, () => 'pad').join(' ')
    const one = [
      record({ path: 'one/short.md', title: 'x', body: `rare ${filler(10)}` }),
      record({
        path: 'one/long.md',
        title: 'x',
        body: `rare rare ${filler(40)}`,
      }),
    ]
    const huge = Array.from({ length: 20 }, (_, i) =>
      record({ path: `two/${i}.md`, title: 'y', body: filler(1000) }),
    )
    const alone = rankExternalSources([entry(one, 'one')], ['rare'], 5)
    const beside = rankExternalSources(
      [entry(one, 'one'), entry(huge, 'two')],
      ['rare'],
      5,
    ).filter((section) => section.name === 'one')
    const order = (sections: ReturnType<typeof rankExternalSources>) =>
      sections[0]?.hits.map((hit) => hit.record.path)
    expect(order(alone)).toEqual(['one/short.md', 'one/long.md'])
    expect(order(beside)).toEqual(order(alone))
  })

  it('keeps a source with no loaded records as a state-only section', () => {
    const [section] = rankExternalSources([entry([], 'quiet')], ['x'], 5)
    expect(section).toMatchObject({ name: 'quiet', state: 'empty', hits: [] })
  })

  it('caps the hits per source at the limit and at 5', () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      record({
        path: `graph/nodes/${i}.json`,
        title: 'needle',
        body: 'needle',
      }),
    )
    expect(
      rankExternalSources([entry(records)], ['needle'], 20)[0]?.hits,
    ).toHaveLength(5)
    expect(
      rankExternalSources([entry(records)], ['needle'], 3)[0]?.hits,
    ).toHaveLength(3)
  })
})
