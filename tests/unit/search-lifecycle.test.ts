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
} from '../../src/lib/search-core.js'
import { type CorpusDocument, loadCorpus } from '../../src/lib/search-corpus.js'

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
