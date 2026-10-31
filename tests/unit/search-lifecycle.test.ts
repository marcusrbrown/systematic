import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  entryStatus,
  isSuccessorPathForm,
  lifecycleLines,
  MAX_SUCCESSOR_HOPS,
  resolveLifecycle,
  resolveSuccessor,
  SUCCESSOR_LABEL,
  successorFormKind,
} from '../../src/lib/search-core.js'
import {
  type CorpusDocument,
  type DocumentKind,
  KIND_TABLE,
  loadCorpus,
} from '../../src/lib/search-corpus.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(ROOT_DIR, 'tests/fixtures/search-corpus')
const DIR = 'docs/solutions/lifecycle'

interface ExpectedCase {
  readonly target: string
  readonly status: string
  readonly supersedes: readonly string[]
  readonly lines: readonly string[]
}

const expected: {
  readonly cases: Readonly<Record<string, ExpectedCase>>
} = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'lifecycle-expected.json'), 'utf8'),
)

const corpus = loadCorpus(path.join(FIXTURES, 'lifecycle'))
const documents = corpus.documents
const p = (name: string) => `${DIR}/${name}.md`

function at(name: string): CorpusDocument {
  const found = documents.find((doc) => doc.path === p(name))
  if (found === undefined) throw new Error(`no fixture ${name}`)
  return found
}

function resolveAlone(name: string) {
  const [entry] = resolveLifecycle([at(name)], documents)
  if (entry === undefined) throw new Error(`${name} was dropped`)
  return entry
}

describe('lifecycle constants', () => {
  it('pins the hop cap at 5', () => {
    expect(MAX_SUCCESSOR_HOPS).toBe(5)
  })
})

describe('resolveLifecycle: every lifecycle fixture, resolved alone', () => {
  const names = Object.keys(expected.cases)

  it('covers every loadable fixture document exactly once', () => {
    const fixtureNames = documents
      .filter((doc) => doc.path.startsWith(`${DIR}/`))
      .map((doc) => doc.path.slice(DIR.length + 1, -'.md'.length))
      .sort()
    expect(names.slice().sort()).toEqual(fixtureNames)
  })

  for (const name of names) {
    it(`${name}`, () => {
      const want = expected.cases[name]
      if (want === undefined) throw new Error('unreachable')
      const entry = resolveAlone(name)
      expect(entry.document.path).toBe(want.target)
      expect([...entry.supersedes]).toEqual([...want.supersedes])
      expect(lifecycleLines(entry)).toEqual([...want.lines])
      expect<string>(entryStatus(entry)).toBe(want.status)
    })
  }

  it('never prints a Skipped: label', () => {
    for (const name of Object.keys(expected.cases)) {
      expect(lifecycleLines(resolveAlone(name)).join('\n')).not.toContain(
        'Skipped:',
      )
    }
  })
})

describe('resolveLifecycle: chains and the hop cap', () => {
  it('resolves A to B when B is active, listing A', () => {
    const entry = resolveAlone('chain-a')
    expect(entry.document.path).toBe(p('chain-b'))
    expect(entry.supersedes).toEqual([p('chain-a')])
    expect(entry.unresolved).toBe(false)
  })

  it('resolves a 5-hop chain and refuses a 6-hop chain', () => {
    expect(resolveAlone('five-0').document.path).toBe(p('five-5'))
    const six = resolveAlone('six-0')
    expect(six.document.path).toBe(p('six-0'))
    expect(six.unresolved).toBe(true)
    // six-1 is exactly five links from six-6.
    expect(resolveAlone('six-1').document.path).toBe(p('six-6'))
  })

  it('treats an unrecognised status as active', () => {
    const entry = resolveAlone('unknown-status')
    expect(entry.document.path).toBe(p('unknown-status'))
    expect(entryStatus(entry)).toBe('active')
    expect(lifecycleLines(entry)).toEqual([])
  })

  it('carries a stale reason, sanitised and truncated', () => {
    const stale: CorpusDocument = {
      ...at('stale-doc'),
      staleReason: `\u001b[31mred\u001b[0m\n${'x'.repeat(500)}`,
    }
    const [entry] = resolveLifecycle([stale], [stale])
    const [line] = entry ? lifecycleLines(entry) : []
    expect(line?.startsWith('Caution: marked stale: red xxx')).toBe(true)
    expect(line).not.toContain('\u001b')
    expect(line?.length).toBeLessThan(260)
    const noReason: CorpusDocument = { ...stale, staleReason: undefined }
    const [bare] = resolveLifecycle([noReason], [noReason])
    expect(bare ? lifecycleLines(bare) : []).toEqual(['Caution: marked stale'])
  })
})

describe('resolveLifecycle: ranked lists', () => {
  it('merges two superseded docs into their shared successor, in path order', () => {
    const entries = resolveLifecycle([at('merge-b'), at('merge-a')], documents)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.document.path).toBe(p('merge-successor'))
    expect(entries[0]?.supersedes).toEqual([p('merge-a'), p('merge-b')])
    expect(entries[0] ? lifecycleLines(entries[0]) : []).toEqual([
      `Supersedes: ${p('merge-a')}, ${p('merge-b')}`,
    ])
  })

  it('gives the merged entry the best rank among successor and replaced docs', () => {
    const successorLast = resolveLifecycle(
      [at('no-status'), at('merge-a'), at('stale-doc'), at('merge-successor')],
      documents,
    ).map((entry) => entry.document.path)
    expect(successorLast).toEqual([
      p('no-status'),
      p('merge-successor'),
      p('stale-doc'),
    ])

    const successorFirst = resolveLifecycle(
      [at('merge-successor'), at('no-status'), at('merge-a')],
      documents,
    )
    expect(successorFirst.map((entry) => entry.document.path)).toEqual([
      p('merge-successor'),
      p('no-status'),
    ])
    expect(successorFirst[0]?.supersedes).toEqual([p('merge-a')])
  })

  it('keeps unresolved and resolvable superseded docs at their own ranks', () => {
    const entries = resolveLifecycle(
      [at('dangling'), at('chain-a'), at('self-link'), at('cycle-a')],
      documents,
    )
    expect(entries.map((entry) => entry.document.path)).toEqual([
      p('dangling'),
      p('chain-b'),
      p('self-link'),
      p('cycle-a'),
    ])
    expect(entries.map((entry) => entry.unresolved)).toEqual([
      true,
      false,
      true,
      true,
    ])
  })

  it('lists a doc that is both unresolved and a link target once each', () => {
    const entries = resolveLifecycle(
      [at('into-dual'), at('dual-unresolved')],
      documents,
    )
    expect(entries.map((entry) => entry.document.path)).toEqual([
      p('into-dual'),
      p('dual-unresolved'),
    ])
    expect(entries.every((entry) => entry.unresolved)).toBe(true)
  })

  it('shows a successor once when it is also a match itself', () => {
    const entries = resolveLifecycle([at('chain-a'), at('chain-b')], documents)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.supersedes).toEqual([p('chain-a')])
  })

  it('drops nothing: every candidate appears, itself or by its successor', () => {
    const everything = documents.filter((doc) => doc.path.startsWith(DIR))
    const entries = resolveLifecycle(everything, documents)
    const shown = new Set(entries.map((entry) => entry.document.path))
    const replaced = new Set(entries.flatMap((entry) => entry.supersedes))
    for (const doc of everything) {
      expect(shown.has(doc.path) || replaced.has(doc.path)).toBe(true)
    }
    expect(new Set(entries.map((entry) => entry.document.path)).size).toBe(
      entries.length,
    )
  })
})

describe('isSuccessorPathForm', () => {
  const cases: Array<[string, boolean]> = [
    ['docs/solutions/a/b.md', true],
    ['docs/solutions/b.md', true],
    ['docs/solutions/../x.md', false],
    ['docs/solutions/a/../b.md', false],
    ['/etc/b.md', false],
    ['b.md', false],
    ['docs/solutions/README.md', false],
    ['docs/solutions/a/readme.md', false],
    ['docs/solutions/_archived/b.md', false],
    ['docs/solutions/a/_archived/b.md', false],
    ['docs/solutions/a/b.txt', false],
    ['docs/solutions/', false],
    ['', false],
    ['docs/solution/a.md', false],
  ]
  for (const [value, ok] of cases) {
    it(`${JSON.stringify(value)} is ${ok ? 'accepted' : 'rejected'}`, () => {
      expect(isSuccessorPathForm(value)).toBe(ok)
    })
  }

  it('a successor skipped by the loader is unresolvable even though its form is valid', () => {
    expect(isSuccessorPathForm(p('broken-target'))).toBe(true)
    const byPath = new Map(documents.map((doc) => [doc.path, doc]))
    expect(byPath.has(p('broken-target'))).toBe(false)
    expect(resolveSuccessor(at('skipped-target'), byPath)).toBeUndefined()
  })
})

type DocFields = Partial<Omit<CorpusDocument, 'path' | 'kind' | 'title'>>

function made(
  kind: DocumentKind,
  name: string,
  fields: DocFields = {},
): CorpusDocument {
  return {
    path: `${KIND_TABLE[kind].dir}/${name}.md`,
    kind,
    title: name,
    tags: [],
    module: undefined,
    component: undefined,
    problemType: undefined,
    symptoms: [],
    appliesWhen: [],
    status: undefined,
    supersededBy: { state: 'none' },
    staleReason: undefined,
    body: '',
    ...fields,
  }
}

const link = (value: string): CorpusDocument['supersededBy'] => ({
  state: 'value',
  value,
})

/** Resolve `candidates` against `corpus` and describe each entry for comparison. */
function describeEntries(
  candidates: readonly CorpusDocument[],
  corpus: readonly CorpusDocument[],
) {
  return resolveLifecycle(candidates, corpus).map((entry) => ({
    path: entry.document.path,
    status: entryStatus(entry),
    lines: lifecycleLines(entry),
  }))
}

describe('isSuccessorPathForm: per kind', () => {
  const cases: Array<[DocumentKind, string, boolean]> = [
    ['plan', 'docs/plans/a.md', true],
    ['plan', 'docs/plans/sub/a.md', true],
    ['plan', 'docs/solutions/a.md', false],
    ['plan', 'docs/plans/README.md', false],
    ['plan', 'docs/plans/_archived/a.md', false],
    ['plan', 'docs/plans/../plans/a.md', false],
    ['plan', 'docs/plans/a.txt', false],
    ['brainstorm', 'docs/brainstorms/a-requirements.md', true],
    ['brainstorm', 'docs/brainstorms/readme.md', false],
    ['ideation', 'docs/ideation/a.md', true],
    ['ideation', 'docs/ideation/_archived/a.md', false],
    ['solution', 'docs/plans/a.md', false],
    ['solution', 'docs/solutions/critical-patterns.md', false],
  ]
  for (const [kind, value, ok] of cases) {
    it(`${kind}: ${JSON.stringify(value)} is ${ok ? 'accepted' : 'rejected'}`, () => {
      expect(isSuccessorPathForm(value, kind)).toBe(ok)
    })
  }

  it('defaults to the solution form', () => {
    expect(isSuccessorPathForm('docs/solutions/a.md')).toBe(true)
    expect(isSuccessorPathForm('docs/plans/a.md')).toBe(false)
  })
})

describe('successorFormKind', () => {
  it('names the kind whose form a link fits, in table order', () => {
    expect(successorFormKind('docs/solutions/a.md')).toBe('solution')
    expect(successorFormKind('docs/plans/a.md')).toBe('plan')
    expect(successorFormKind('docs/brainstorms/a.md')).toBe('brainstorm')
    expect(successorFormKind('docs/ideation/a.md')).toBe('ideation')
  })

  it('names nothing for a link that fits no kind', () => {
    for (const value of [
      '',
      '../x.md',
      '/docs/plans/x.md',
      'docs/other/x.md',
      'docs/plans/README.md',
      'docs/plans/_archived/x.md',
      'docs/plans/x.txt',
    ]) {
      expect(successorFormKind(value)).toBeUndefined()
    }
  })
})

describe('lifecycle for plans, brainstorms and ideation', () => {
  it('replaces a superseded plan with its completed successor (AE3)', () => {
    const p1 = made('plan', 'p1', {
      status: 'superseded',
      supersededBy: link('docs/plans/p2.md'),
    })
    const p2 = made('plan', 'p2', { status: 'completed' })
    expect(describeEntries([p1], [p1, p2])).toEqual([
      {
        path: p2.path,
        status: 'completed',
        lines: ['Supersedes: docs/plans/p1.md'],
      },
    ])
  })

  it('keeps a plan whose successor is a solution and prints a Successor line (AE4)', () => {
    const p1 = made('plan', 'p1', {
      status: 'superseded',
      supersededBy: link('docs/solutions/x.md'),
    })
    // The solution neither matches the query nor exists in the corpus.
    expect(describeEntries([p1], [p1])).toEqual([
      {
        path: p1.path,
        status: 'superseded',
        lines: ['Successor: docs/solutions/x.md'],
      },
    ])
  })

  it('stops a chain at the first cross-kind link and keeps the last same-kind document', () => {
    const p1 = made('plan', 'p1', {
      status: 'superseded',
      supersededBy: link('docs/plans/p2.md'),
    })
    const p2 = made('plan', 'p2', {
      status: 'superseded',
      supersededBy: link('docs/solutions/x.md'),
    })
    expect(describeEntries([p1], [p1, p2])).toEqual([
      {
        path: p2.path,
        status: 'superseded',
        lines: [
          'Supersedes: docs/plans/p1.md',
          'Successor: docs/solutions/x.md',
        ],
      },
    ])
  })

  it('does not follow a cross-kind link even when the target is loaded and superseded', () => {
    const p1 = made('plan', 'p1', {
      status: 'superseded',
      supersededBy: link('docs/brainstorms/b.md'),
    })
    const b = made('brainstorm', 'b', {
      status: 'superseded',
      supersededBy: link('docs/plans/p1.md'),
    })
    expect(describeEntries([p1, b], [p1, b])).toEqual([
      {
        path: p1.path,
        status: 'superseded',
        lines: ['Successor: docs/brainstorms/b.md'],
      },
      {
        path: b.path,
        status: 'superseded',
        lines: ['Successor: docs/plans/p1.md'],
      },
    ])
  })

  it('keeps a solution whose successor is a plan and prints a Successor line', () => {
    const s = made('solution', 's', {
      status: 'superseded',
      supersededBy: link('docs/plans/p.md'),
    })
    const entries = describeEntries([s], [s])
    expect(entries).toEqual([
      {
        path: s.path,
        status: 'superseded',
        lines: ['Successor: docs/plans/p.md'],
      },
    ])
    expect(entries[0]?.lines.join('\n')).not.toContain('Caution')
  })

  it('prints a mutual cross-kind pair without a caution', () => {
    const s = made('solution', 's', {
      status: 'superseded',
      supersededBy: link('docs/plans/p.md'),
    })
    const p = made('plan', 'p', {
      status: 'superseded',
      supersededBy: link('docs/solutions/s.md'),
    })
    for (const entry of describeEntries([s, p], [s, p])) {
      expect(entry.lines).toHaveLength(1)
      expect(entry.lines[0]?.startsWith('Successor: ')).toBe(true)
    }
  })

  it('merges two superseded plans into one successor with sorted paths', () => {
    const a = made('plan', 'a', {
      status: 'superseded',
      supersededBy: link('docs/plans/z.md'),
    })
    const b = made('plan', 'b', {
      status: 'superseded',
      supersededBy: link('docs/plans/z.md'),
    })
    const z = made('plan', 'z', { status: 'completed' })
    expect(describeEntries([b, a], [a, b, z])).toEqual([
      {
        path: z.path,
        status: 'completed',
        lines: ['Supersedes: docs/plans/a.md, docs/plans/b.md'],
      },
    ])
  })

  it('merges a successor that is also a direct hit at the better rank', () => {
    const a = made('plan', 'a', {
      status: 'superseded',
      supersededBy: link('docs/plans/z.md'),
    })
    const other = made('plan', 'other')
    const z = made('plan', 'z', { status: 'completed' })
    const entries = resolveLifecycle([z, other, a], [a, other, z])
    expect(entries.map((entry) => entry.document.path)).toEqual([
      z.path,
      other.path,
    ])
    expect(entries[0]?.supersedes).toEqual([a.path])
  })

  it('shows a cross-kind link on a document that is also a direct hit once', () => {
    const p1 = made('plan', 'p1', {
      status: 'superseded',
      supersededBy: link('docs/plans/p2.md'),
    })
    const p2 = made('plan', 'p2', {
      status: 'superseded',
      supersededBy: link('docs/solutions/x.md'),
    })
    const entries = describeEntries([p2, p1], [p1, p2])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.lines).toEqual([
      'Supersedes: docs/plans/p1.md',
      'Successor: docs/solutions/x.md',
    ])
  })

  it('counts a cross-kind link as a hop and refuses a chain of six', () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      made('plan', `c${index}`, {
        status: 'superseded',
        supersededBy: link(
          index === 5 ? 'docs/solutions/x.md' : `docs/plans/c${index + 1}.md`,
        ),
      }),
    )
    // c0 reaches the cross-kind link of c5 on its sixth link: unresolved.
    const head = chain[0] as CorpusDocument
    const tail = chain[5] as CorpusDocument
    const [first] = describeEntries([head], chain)
    expect(first).toEqual({
      path: head.path,
      status: 'superseded',
      lines: ['Caution: successor unresolved'],
    })
    // c1 reaches it on its fifth link: resolved with a Successor line.
    const [second] = describeEntries([chain[1] as CorpusDocument], chain)
    expect(second).toEqual({
      path: tail.path,
      status: 'superseded',
      lines: ['Supersedes: docs/plans/c1.md', 'Successor: docs/solutions/x.md'],
    })
  })

  it('treats a cycle and a self-link as unresolved', () => {
    const a = made('plan', 'a', {
      status: 'superseded',
      supersededBy: link('docs/plans/b.md'),
    })
    const b = made('plan', 'b', {
      status: 'superseded',
      supersededBy: link('docs/plans/a.md'),
    })
    const self = made('plan', 'self', {
      status: 'superseded',
      supersededBy: link('docs/plans/self.md'),
    })
    for (const entry of describeEntries([a, self], [a, b, self])) {
      expect(entry.lines).toEqual(['Caution: successor unresolved'])
      expect(entry.status).toBe('superseded')
    }
  })

  it('matches superseded and stale case-insensitively for the new kinds', () => {
    const old = made('plan', 'old', {
      status: ' Superseded ',
      supersededBy: link('docs/plans/new.md'),
    })
    const fresh = made('plan', 'new', { status: 'Completed' })
    expect(describeEntries([old], [old, fresh])).toEqual([
      {
        path: fresh.path,
        status: 'Completed',
        lines: ['Supersedes: docs/plans/old.md'],
      },
    ])
    const stale = made('brainstorm', 'b', {
      status: 'STALE',
      staleReason: 'replaced by a newer idea',
    })
    expect(describeEntries([stale], [stale])).toEqual([
      {
        path: stale.path,
        status: 'STALE',
        lines: ['Caution: marked stale: replaced by a newer idea'],
      },
    ])
  })

  it('keeps the exact match for solutions', () => {
    const old = made('solution', 'old', {
      status: 'Superseded',
      supersededBy: link('docs/solutions/new.md'),
    })
    const fresh = made('solution', 'new')
    expect(describeEntries([old], [old, fresh])).toEqual([
      { path: old.path, status: 'active', lines: [] },
    ])
    const stale = made('solution', 'stale', { status: 'Stale' })
    expect(describeEntries([stale], [stale])).toEqual([
      { path: stale.path, status: 'active', lines: [] },
    ])
  })

  it('shows the recorded status raw, or unspecified when there is none', () => {
    const cases: Array<[CorpusDocument, string]> = [
      [made('brainstorm', 'a', { status: 'deferred' }), 'deferred'],
      [made('ideation', 'b'), 'unspecified'],
      [made('plan', 'c', { status: 'Completed' }), 'Completed'],
      [made('plan', 'd', { status: '   ' }), 'unspecified'],
      [made('plan', 'e', { status: 'x'.repeat(50) }), 'x'.repeat(50)],
    ]
    for (const [doc, shown] of cases) {
      expect(describeEntries([doc], [doc])).toEqual([
        { path: doc.path, status: shown, lines: [] },
      ])
    }
  })

  it('treats archived as an ordinary status: no successor handling and no caution', () => {
    const archived = made('plan', 'a', {
      status: 'archived',
      supersededBy: link('docs/plans/b.md'),
    })
    const b = made('plan', 'b')
    expect(describeEntries([archived], [archived, b])).toEqual([
      { path: archived.path, status: 'archived', lines: [] },
    ])
  })

  it('keeps a superseded document with no or a malformed link, with a caution', () => {
    const values: Array<CorpusDocument['supersededBy']> = [
      { state: 'none' },
      { state: 'invalid' },
      link(''),
      link('../x.md'),
      link('docs/plans/README.md'),
      link('docs/plans/_archived/x.md'),
      link('/docs/plans/x.md'),
      link('docs/other/x.md'),
      link('docs/plans/missing.md'),
    ]
    for (const supersededBy of values) {
      const doc = made('plan', 'p', { status: 'superseded', supersededBy })
      expect(describeEntries([doc], [doc])).toEqual([
        {
          path: doc.path,
          status: 'superseded',
          lines: ['Caution: successor unresolved'],
        },
      ])
    }
  })

  it('does not check that a cross-kind target exists', () => {
    const p = made('plan', 'p', {
      status: 'superseded',
      supersededBy: link('docs/brainstorms/never-written.md'),
    })
    expect(describeEntries([p], [p])[0]?.lines).toEqual([
      'Successor: docs/brainstorms/never-written.md',
    ])
  })

  it('exports the Successor label', () => {
    expect(SUCCESSOR_LABEL).toBe('Successor:')
  })
})
