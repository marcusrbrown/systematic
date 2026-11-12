import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  planOffer,
  projectKey,
  type RuleEntry,
  renderSweepLine,
  sweepProgress,
} from '../../src/lib/connect-helper-core.js'
import {
  acquireLock,
  type CoverageRecord,
  type CoverageUpdate,
  clearLedger,
  decideLedgerEntry,
  type LockHandle,
  prepareStateRoot,
  publishRun,
  readLedger,
  releaseLock,
} from '../../src/lib/connect-state.js'
import { cleanupTempDirs, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

// ── Fixtures ────────────────────────────────────────────────────────────────

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function ruleId(n: number): string {
  return `rule-${n.toString(16).padStart(16, '0')}`
}

function rule(
  n: number,
  project: string,
  relPath: string,
  sha256 = HASH_A,
): RuleEntry {
  return {
    id: ruleId(n),
    project,
    path: relPath,
    sha256,
    appliesWhen: [],
    missing: [],
    parseError: false,
  }
}

function record(
  n: number,
  at: string,
  hash = HASH_A,
  runId = `run-${at}`,
): CoverageRecord {
  return { ruleId: ruleId(n), hash, runId, at }
}

/** Three projects, four rules each, numbered by project then path. */
function corpus(): RuleEntry[] {
  const out: RuleEntry[] = []
  let n = 1
  for (const project of ['/p/alpha', '/p/beta', '/p/gamma']) {
    for (const file of ['a', 'b', 'c', 'd']) {
      out.push(rule(n++, project, `docs/solutions/${file}.md`))
    }
  }
  return out
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items]
  let seed = 7
  for (let i = copy.length - 1; i > 0; i--) {
    seed = (seed * 48271) % 2147483647
    const j = seed % (i + 1)
    const a = copy[i] as T
    copy[i] = copy[j] as T
    copy[j] = a
  }
  return copy
}

function pathsOf(rules: readonly RuleEntry[], ids: readonly string[]) {
  return ids.map((id) => {
    const found = rules.find((r) => r.id === id)
    return `${path.basename(found?.project ?? '?')}/${path.basename(found?.path ?? '?')}`
  })
}

// ── planOffer ───────────────────────────────────────────────────────────────

describe('planOffer', () => {
  it('orders a never-covered corpus round-robin across projects, then by path', () => {
    const rules = corpus()
    const offer = planOffer({ rules, coverage: [], size: rules.length })

    expect(pathsOf(rules, offer.order)).toEqual([
      'alpha/a.md',
      'beta/a.md',
      'gamma/a.md',
      'alpha/b.md',
      'beta/b.md',
      'gamma/b.md',
      'alpha/c.md',
      'beta/c.md',
      'gamma/c.md',
      'alpha/d.md',
      'beta/d.md',
      'gamma/d.md',
    ])
  })

  it('gives the same order whatever order the rules arrive in', () => {
    const rules = corpus()
    const coverage = [record(2, '2026-11-01T00:00:00Z'), record(7, 'z')]
    const baseline = planOffer({ rules, coverage, size: 5 })

    for (const input of [
      [...rules].reverse(),
      shuffled(rules),
      shuffled(shuffled(rules)),
    ]) {
      const again = planOffer({
        rules: input,
        coverage: shuffled(coverage),
        size: 5,
      })
      expect(again.order).toEqual(baseline.order)
      expect(again.offered).toEqual(baseline.offered)
    }
  })

  it('offers at most the slice size and keeps the slice as the head of the order', () => {
    const rules = corpus()
    const offer = planOffer({ rules, coverage: [], size: 5 })

    expect(offer.offered).toHaveLength(5)
    expect(offer.order.slice(0, 5)).toEqual([...offer.offered])
    expect(offer.order).toHaveLength(rules.length)
    expect(new Set(offer.order).size).toBe(rules.length)
    // A slice spans every project when it is longer than the project count.
    const projects = new Set(
      offer.offered.map((id) => rules.find((r) => r.id === id)?.project),
    )
    expect(projects.size).toBe(3)
  })

  it('offers the whole corpus when it fits in one slice', () => {
    const rules = corpus()
    const offer = planOffer({ rules, coverage: [], size: 48 })
    expect(offer.offered).toHaveLength(rules.length)
  })

  it('offers never-covered rules before covered ones', () => {
    const rules = corpus()
    // Everything in alpha was covered; beta and gamma were not.
    const coverage = [1, 2, 3, 4].map((n) => record(n, '2026-11-01T00:00:00Z'))
    const offer = planOffer({ rules, coverage, size: 8 })

    expect(
      pathsOf(rules, offer.offered).every((p) => !p.startsWith('alpha')),
    ).toBe(true)
    expect(offer.order.slice(8)).toEqual([1, 2, 3, 4].map(ruleId))
  })

  it('re-offers a rule whose learning hash changed since it was covered', () => {
    const rules = corpus()
    const coverage = rules.map((_rule, i) =>
      record(i + 1, '2026-11-01T00:00:00Z'),
    )
    const edited = rules.map((r) =>
      r.id === ruleId(6) ? { ...r, sha256: HASH_B } : r,
    )
    const offer = planOffer({ rules: edited, coverage, size: 3 })

    expect(offer.offered[0]).toBe(ruleId(6))
    expect(offer.fresh).toEqual([ruleId(6)])
    expect(offer.coveredBefore).toBe(rules.length - 1)
  })

  it('wraps to the least recently covered rules once everything is covered', () => {
    const rules = corpus()
    const old = '2026-10-01T00:00:00Z'
    const recent = '2026-11-01T00:00:00Z'
    // Rules 9..12 (gamma) were covered longest ago, then 1..4, then the rest.
    const coverage = [
      ...[9, 10, 11, 12].map((n) => record(n, old)),
      ...[1, 2, 3, 4].map((n) => record(n, '2026-10-15T00:00:00Z')),
      ...[5, 6, 7, 8].map((n) => record(n, recent)),
    ]
    const offer = planOffer({ rules, coverage, size: 4 })

    expect(offer.fresh).toEqual([])
    expect(offer.offered).toEqual([9, 10, 11, 12].map(ruleId))
    expect(offer.order.slice(4, 8)).toEqual([1, 2, 3, 4].map(ruleId))
    expect(offer.order.slice(8)).toEqual([5, 6, 7, 8].map(ruleId))
  })

  it('breaks a recency tie by run id, not by chance', () => {
    const rules = corpus().slice(0, 2)
    const coverage = [
      record(1, '2026-11-01T00:00:00Z', HASH_A, 'run-b'),
      record(2, '2026-11-01T00:00:00Z', HASH_A, 'run-a'),
    ]
    const offer = planOffer({ rules, coverage, size: 1 })
    expect(offer.offered).toEqual([ruleId(2)])
  })

  it('interleaves projects inside one recency group', () => {
    const rules = corpus()
    const same = '2026-11-01T00:00:00Z'
    const coverage = rules.map((_, i) => record(i + 1, same))
    const offer = planOffer({ rules, coverage, size: 6 })

    expect(pathsOf(rules, offer.offered)).toEqual([
      'alpha/a.md',
      'beta/a.md',
      'gamma/a.md',
      'alpha/b.md',
      'beta/b.md',
      'gamma/b.md',
    ])
  })

  it('ignores coverage of a rule the index no longer holds', () => {
    const rules = corpus().slice(0, 4)
    const coverage = [record(99, '2026-11-01T00:00:00Z')]
    const offer = planOffer({ rules, coverage, size: 4 })
    expect(offer.coveredBefore).toBe(0)
    expect(offer.fresh).toHaveLength(4)
  })

  it('offers nothing for an empty index', () => {
    const offer = planOffer({ rules: [], coverage: [], size: 48 })
    expect(offer.offered).toEqual([])
    expect(offer.order).toEqual([])
    expect(offer.total).toBe(0)
  })

  it('never offers more than one rule per slot even when the size is zero', () => {
    const offer = planOffer({ rules: corpus(), coverage: [], size: 0 })
    expect(offer.offered).toHaveLength(1)
  })
})

// ── sweep progress ──────────────────────────────────────────────────────────

describe('sweepProgress', () => {
  it('counts new coverage and the runs left at the slice size', () => {
    const rules = corpus()
    const offer = planOffer({ rules, coverage: [], size: 5 })
    const progress = sweepProgress(offer, offer.offered.slice(0, 4))

    expect(progress).toEqual({
      total: 12,
      covered: 4,
      coveredThisRun: 4,
      runsLeft: 2,
    })
  })

  it('does not count a re-covered rule twice', () => {
    const rules = corpus()
    const coverage = rules.map((_, i) => record(i + 1, '2026-11-01T00:00:00Z'))
    const offer = planOffer({ rules, coverage, size: 5 })
    const progress = sweepProgress(offer, offer.offered)

    expect(progress.covered).toBe(12)
    expect(progress.coveredThisRun).toBe(5)
    expect(progress.runsLeft).toBe(0)
  })

  it('counts nothing when the run covered nothing', () => {
    const rules = corpus()
    const offer = planOffer({ rules, coverage: [], size: 5 })
    expect(sweepProgress(offer, [])).toEqual({
      total: 12,
      covered: 0,
      coveredThisRun: 0,
      runsLeft: 3,
    })
  })

  it('ignores an id the run was not offered', () => {
    const rules = corpus()
    const offer = planOffer({ rules, coverage: [], size: 2 })
    const outside = offer.order[5] as string
    expect(sweepProgress(offer, [outside]).coveredThisRun).toBe(0)
  })
})

describe('renderSweepLine', () => {
  it('states covered of total, this run and the runs left', () => {
    expect(
      renderSweepLine({
        total: 376,
        covered: 120,
        coveredThisRun: 48,
        runsLeft: 6,
      }),
    ).toBe(
      'Sweep: covered 120 of 376 rules (current hashes); this run covered 48; about 6 runs left in the sweep.',
    )
  })

  it('uses the singular for one run', () => {
    expect(
      renderSweepLine({
        total: 50,
        covered: 48,
        coveredThisRun: 48,
        runsLeft: 1,
      }),
    ).toContain('about 1 run left in the sweep')
  })

  it('says the sweep is complete and what the next run does', () => {
    const line = renderSweepLine({
      total: 12,
      covered: 12,
      coveredThisRun: 12,
      runsLeft: 0,
    })
    expect(line).toContain('covered 12 of 12 rules (current hashes)')
    expect(line).toMatch(/sweep is complete/)
    expect(line).toMatch(/least recently covered/)
  })

  it('says nothing when there are no rules', () => {
    expect(
      renderSweepLine({ total: 0, covered: 0, coveredThisRun: 0, runsLeft: 0 }),
    ).toBe('')
  })
})

// ── Coverage in the ledger ──────────────────────────────────────────────────

function newRoot(): string {
  const result = prepareStateRoot(
    path.join(makeDir('connect-coverage-'), 'state'),
    { allowedRoots: [] },
  )
  if (result.status !== 'ok') throw new Error(`state root ${result.reason}`)
  return result.root
}

const PROCS = {
  isAlive: (pid: number) => pid === 7001,
  startTime: (pid: number) => (pid === 7001 ? 'self' : undefined),
}

function locked<T>(root: string, fn: (lock: LockHandle) => T): T {
  const acquired = acquireLock(root, {
    pid: 7001,
    processes: PROCS,
    now: () => Date.UTC(2026, 10, 1),
  })
  if (acquired.status !== 'acquired') throw new Error(`lock ${acquired.status}`)
  try {
    return fn(acquired.lock)
  } finally {
    releaseLock(acquired.lock)
  }
}

function update(
  runId: string,
  ids: readonly number[],
  covered: readonly number[],
  hash = HASH_A,
): CoverageUpdate {
  return {
    runId,
    indexed: ids.map((n) => ({ ruleId: ruleId(n), hash })),
    covered: covered.map(ruleId),
  }
}

function publish(
  root: string,
  runId: string,
  coverage: CoverageUpdate | undefined,
  hooks?: { beforeCommit?: () => void; afterCommit?: () => void },
) {
  return locked(root, (lock) =>
    publishRun(
      root,
      lock,
      {
        runId,
        files: { 'digest.md': '# digest\n', 'run.json': '{}\n' },
        candidates: [],
        ...(coverage === undefined ? {} : { coverage }),
      },
      { now: () => Date.UTC(2026, 10, 1, 12), hooks },
    ),
  )
}

function coverageOf(root: string): readonly CoverageRecord[] {
  const read = readLedger(root)
  if (read.status !== 'ok') throw new Error(`ledger ${read.reason}`)
  return read.ledger.coverage ?? []
}

describe('coverage in the ledger', () => {
  it('records a covered rule with its hash, run id and time', () => {
    const root = newRoot()
    const result = publish(
      root,
      '20261101T120000Z-aaaa1111',
      update('20261101T120000Z-aaaa1111', [1, 2, 3], [1, 3]),
    )

    expect(result.status).toBe('published')
    expect(coverageOf(root)).toEqual([
      {
        ruleId: ruleId(1),
        hash: HASH_A,
        runId: '20261101T120000Z-aaaa1111',
        at: '2026-11-01T12:00:00.000Z',
      },
      {
        ruleId: ruleId(3),
        hash: HASH_A,
        runId: '20261101T120000Z-aaaa1111',
        at: '2026-11-01T12:00:00.000Z',
      },
    ])
  })

  it('keeps nothing but ids, hashes and times: no text', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    const text = fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')
    const parsed = JSON.parse(text) as {
      coverage: Array<Record<string, unknown>>
    }
    for (const item of parsed.coverage) {
      expect(Object.keys(item).sort()).toEqual([
        'at',
        'hash',
        'ruleId',
        'runId',
      ])
    }
  })

  it('updates a rule when a later run covers it again, and leaves the others alone', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1, 2], [1, 2]))
    publish(root, 'run-two', update('run-two', [1, 2], [2]))

    const byRule = new Map(coverageOf(root).map((c) => [c.ruleId, c.runId]))
    expect(byRule.get(ruleId(1))).toBe('run-one')
    expect(byRule.get(ruleId(2))).toBe('run-two')
  })

  it('stores the new hash when a changed learning is covered again', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1], HASH_A))
    publish(root, 'run-two', update('run-two', [1], [1], HASH_B))
    expect(coverageOf(root)[0]?.hash).toBe(HASH_B)
  })

  it('keeps the old hash for a changed learning the run did not cover', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1], HASH_A))
    publish(root, 'run-two', update('run-two', [1], [], HASH_B))
    expect(coverageOf(root)[0]?.hash).toBe(HASH_A)
  })

  it('drops the coverage of a rule whose learning is gone from the index', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1, 2], [1, 2]))
    publish(root, 'run-two', update('run-two', [1], [1]))
    expect(coverageOf(root).map((c) => c.ruleId)).toEqual([ruleId(1)])
  })

  it('leaves coverage untouched when the publish names none', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    publish(root, 'run-two', undefined)
    expect(coverageOf(root).map((c) => c.ruleId)).toEqual([ruleId(1)])
  })

  it('covers only rules the run indexed', () => {
    const root = newRoot()
    const result = publish(root, 'run-one', update('run-one', [1], [1, 2]))
    expect(result).toEqual({ status: 'failed', reason: 'invalid-coverage' })
    expect(fs.existsSync(path.join(root, 'runs', 'run-one'))).toBe(false)
  })

  it('refuses a malformed coverage update before anything is staged', () => {
    const root = newRoot()
    const bad: CoverageUpdate = {
      runId: 'run-one',
      indexed: [{ ruleId: 'not-a-rule', hash: HASH_A }],
      covered: [],
    }
    expect(publish(root, 'run-one', bad)).toEqual({
      status: 'failed',
      reason: 'invalid-coverage',
    })
    expect(fs.existsSync(path.join(root, 'runs', 'run-one'))).toBe(false)
  })

  it('records nothing when the run dies before the rename', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1, 2], [1]))
    const before = fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')

    expect(() =>
      publish(root, 'run-two', update('run-two', [1, 2], [2]), {
        beforeCommit: () => {
          throw new Error('crash')
        },
      }),
    ).toThrow('crash')

    expect(fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')).toBe(before)
    expect(coverageOf(root).map((c) => c.ruleId)).toEqual([ruleId(1)])
  })

  it('records nothing for a crash between the rename and the ledger write', () => {
    const root = newRoot()
    expect(() =>
      publish(root, 'run-one', update('run-one', [1], [1]), {
        afterCommit: () => {
          throw new Error('crash')
        },
      }),
    ).toThrow('crash')

    expect(fs.existsSync(path.join(root, 'runs', 'run-one'))).toBe(true)
    expect(coverageOf(root)).toEqual([])
  })

  it('keeps coverage when a decision rewrites the ledger', () => {
    const root = newRoot()
    const prior = locked(root, (lock) =>
      publishRun(
        root,
        lock,
        {
          runId: 'run-one',
          files: { 'digest.md': '# d\n', 'run.json': '{}\n' },
          candidates: [
            {
              kind: 'transferable-lesson',
              target: '/p/alpha',
              ruleId: ruleId(1),
              sources: [
                {
                  role: 'solution',
                  path: 'docs/solutions/a.md',
                  fingerprint: HASH_A,
                },
              ],
              targetEvidence: [{ path: 'src/x.ts', fingerprint: HASH_B }],
            },
          ],
          coverage: update('run-one', [1], [1]),
        },
        { now: () => Date.UTC(2026, 10, 1) },
      ),
    )
    if (prior.status !== 'published') throw new Error('publish failed')
    const read = readLedger(root)
    if (read.status !== 'ok') throw new Error('ledger')
    const id = read.ledger.entries[0]?.id as string

    const decided = decideLedgerEntry(
      root,
      { id, status: 'rejected', reason: 'not a fit' },
      { pid: 7001, processes: PROCS },
    )
    expect(decided.status).toBe('decided')
    expect(coverageOf(root).map((c) => c.ruleId)).toEqual([ruleId(1)])
  })

  it('is cleared with the ledger', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    const cleared = clearLedger(root, { pid: 7001, processes: PROCS })

    expect(cleared).toEqual({ status: 'cleared', removed: true })
    expect(coverageOf(root)).toEqual([])
  })

  it.each([
    ['a non-array', { version: 1, entries: [], coverage: {} }],
    [
      'a bad rule id',
      {
        version: 1,
        entries: [],
        coverage: [{ ruleId: 'x', hash: HASH_A, runId: 'r', at: 't' }],
      },
    ],
    [
      'a bad hash',
      {
        version: 1,
        entries: [],
        coverage: [{ ruleId: ruleId(1), hash: 'nope', runId: 'r', at: 't' }],
      },
    ],
    [
      'a repeated rule',
      {
        version: 1,
        entries: [],
        coverage: [
          { ruleId: ruleId(1), hash: HASH_A, runId: 'r', at: 't' },
          { ruleId: ruleId(1), hash: HASH_A, runId: 'r', at: 't' },
        ],
      },
    ],
  ])('reads a ledger with %s as unreadable, never as empty', (_name, body) => {
    const root = newRoot()
    fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify(body))
    expect(readLedger(root)).toEqual({
      status: 'unreadable',
      reason: 'invalid',
    })
  })

  it('reads an older ledger with no coverage as having none', () => {
    const root = newRoot()
    fs.writeFileSync(
      path.join(root, 'ledger.json'),
      JSON.stringify({ version: 1, entries: [] }),
    )
    expect(coverageOf(root)).toEqual([])
  })
})

// ── A sweep with no selection ───────────────────────────────────────────────

/** Plan an offer from the ledger's coverage, then publish a run that covers all of it. */
function sweepRun(
  root: string,
  runId: string,
  rules: readonly RuleEntry[],
  size: number,
  selection?: string,
): ReturnType<typeof planOffer> {
  const offer = planOffer({
    rules,
    coverage: coverageOf(root),
    size,
    ...(selection === undefined ? {} : { selection }),
  })
  publish(root, runId, {
    runId,
    indexed: rules.map((item) => ({
      ruleId: item.id,
      hash: item.sha256,
      project: projectKey(item.project),
    })),
    covered: offer.offered,
    ...(selection === undefined ? {} : { selection }),
  })
  return offer
}

describe('a sweep with no selection', () => {
  it('covers every rule once across runs, then starts again with the oldest', () => {
    const root = newRoot()
    const rules = corpus()
    const first = sweepRun(root, '20261101T010000Z-aaaa0001', rules, 5)
    const second = sweepRun(root, '20261101T020000Z-aaaa0002', rules, 5)
    const third = sweepRun(root, '20261101T030000Z-aaaa0003', rules, 5)
    const fourth = sweepRun(root, '20261101T040000Z-aaaa0004', rules, 5)

    const seen = new Set<string>()
    for (const offer of [first, second]) {
      for (const id of offer.offered) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
    expect(first.fresh).toEqual(first.offered)
    expect(second.fresh).toEqual(second.offered)
    // The third run finishes the sweep: two never-covered rules, then the oldest.
    expect(third.fresh).toHaveLength(2)
    expect(coverageOf(root)).toHaveLength(12)
    expect(fourth.coveredBefore).toBe(12)
    expect(fourth.fresh).toEqual([])
    // The rules the third run did not offer again are the least recently covered.
    const leftFromFirst = first.offered.filter(
      (id) => !third.offered.includes(id),
    )
    expect(leftFromFirst).toHaveLength(2)
    expect(new Set(fourth.offered.slice(0, 2))).toEqual(new Set(leftFromFirst))
  })

  it('writes coverage records that carry no selection field', () => {
    const root = newRoot()
    sweepRun(root, '20261101T010000Z-aaaa0001', corpus(), 5)

    for (const item of coverageOf(root)) {
      expect(Object.keys(item).sort()).toEqual([
        'at',
        'hash',
        'project',
        'ruleId',
        'runId',
      ])
    }
  })
})

// ── planOffer and a selection ───────────────────────────────────────────────

const SEL_A = 'a1b2c3d4e5f60718'
const SEL_B = '0123456789abcdef'

function inSelection(
  selection: string,
  item: CoverageRecord,
): CoverageRecord & { selection: string } {
  return { ...item, selection }
}

describe('planOffer within a selection', () => {
  it('counts only the records of its own selection as covered', () => {
    const rules = corpus()
    const coverage = [
      record(1, '2026-11-01T00:00:00Z'),
      inSelection(SEL_A, record(2, '2026-11-01T00:00:00Z')),
      inSelection(SEL_B, record(3, '2026-11-01T00:00:00Z')),
    ]

    expect(planOffer({ rules, coverage, size: 12 }).coveredBefore).toBe(1)
    expect(
      planOffer({ rules, coverage, size: 12, selection: SEL_A }).coveredBefore,
    ).toBe(1)
    expect(
      planOffer({ rules, coverage, size: 12, selection: SEL_B }).coveredBefore,
    ).toBe(1)
    expect(
      planOffer({ rules, coverage, size: 12, selection: 'f'.repeat(16) })
        .coveredBefore,
    ).toBe(0)
  })

  it('still offers a rule that only a selection covered when there is no selection', () => {
    const rules = corpus()
    const coverage = [inSelection(SEL_A, record(1, '2026-11-01T00:00:00Z'))]
    const offer = planOffer({ rules, coverage, size: 12 })

    expect(offer.coveredBefore).toBe(0)
    expect(offer.fresh).toContain(ruleId(1))
    expect(offer.fresh).toHaveLength(12)
  })

  it('does not let a record of no selection stand in for a selection', () => {
    const rules = corpus()
    const coverage = [record(1, '2026-11-01T00:00:00Z')]
    const offer = planOffer({ rules, coverage, size: 12, selection: SEL_A })

    expect(offer.coveredBefore).toBe(0)
    expect(offer.fresh).toHaveLength(12)
  })
})

// ── Coverage per selection in the ledger ────────────────────────────────────

function ledgerPath(root: string): string {
  return path.join(root, 'ledger.json')
}

function writeLedgerFile(root: string, body: unknown): string {
  const text = `${JSON.stringify(body, null, 2)}\n`
  fs.writeFileSync(ledgerPath(root), text)
  return text
}

function selectionUpdate(
  runId: string,
  selection: string,
  ids: readonly number[],
  covered: readonly number[],
  hash = HASH_A,
): CoverageUpdate {
  return { ...update(runId, ids, covered, hash), selection }
}

function summary(root: string): Array<[string, string, string]> {
  return coverageOf(root).map((item) => [
    item.ruleId,
    item.selection ?? 'all',
    item.runId,
  ])
}

describe('coverage per selection', () => {
  it('records a selection run under its own selection and leaves the others alone', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1, 2], [1, 2]))
    publish(root, 'run-two', selectionUpdate('run-two', SEL_A, [1, 3], [1, 3]))

    expect(summary(root)).toEqual([
      [ruleId(1), 'all', 'run-one'],
      [ruleId(1), SEL_A, 'run-two'],
      [ruleId(2), 'all', 'run-one'],
      [ruleId(3), SEL_A, 'run-two'],
    ])
  })

  it('updates a rule only inside the selection of the run that covers it', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    publish(root, 'run-two', selectionUpdate('run-two', SEL_A, [1], [1]))
    publish(root, 'run-three', selectionUpdate('run-three', SEL_A, [1], [1]))
    publish(root, 'run-four', update('run-four', [1], [1]))

    expect(summary(root)).toEqual([
      [ruleId(1), 'all', 'run-four'],
      [ruleId(1), SEL_A, 'run-three'],
    ])
  })

  it('drops a rule that is gone from the index only in the selection that indexed it', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1, 2], [1, 2]))
    publish(root, 'run-two', selectionUpdate('run-two', SEL_A, [1, 2], [1, 2]))
    publish(root, 'run-three', selectionUpdate('run-three', SEL_A, [1], [1]))

    expect(summary(root)).toEqual([
      [ruleId(1), 'all', 'run-one'],
      [ruleId(1), SEL_A, 'run-three'],
      [ruleId(2), 'all', 'run-one'],
    ])
  })

  it('leaves the record of another selection as it is when a run indexes the rule and does not cover it', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    publish(root, 'run-two', selectionUpdate('run-two', SEL_A, [1], []))
    publish(root, 'run-three', update('run-three', [1], []))

    expect(summary(root)).toEqual([[ruleId(1), 'all', 'run-one']])
    expect(readLedger(root).status).toBe('ok')
  })

  it('keeps every selection when a run with no selection prunes its own', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1, 2], [1, 2]))
    publish(root, 'run-two', selectionUpdate('run-two', SEL_A, [2], [2]))
    publish(root, 'run-three', update('run-three', [1], [1]))

    expect(summary(root)).toEqual([
      [ruleId(1), 'all', 'run-three'],
      [ruleId(2), SEL_A, 'run-two'],
    ])
  })

  it('refuses a malformed selection id before anything is staged', () => {
    const root = newRoot()
    for (const selection of ['', 'A1B2C3D4E5F60718', 'abc', 'g'.repeat(16)]) {
      expect(
        publish(
          root,
          'run-one',
          selectionUpdate('run-one', selection, [1], [1]),
        ),
      ).toEqual({ status: 'failed', reason: 'invalid-coverage' })
    }
    expect(fs.existsSync(path.join(root, 'runs', 'run-one'))).toBe(false)
  })

  it('drops the oldest records of any selection when the ledger would hold too many', () => {
    const root = newRoot()
    const cap = 20_000
    const seeded = Array.from({ length: cap }, (_, i) => ({
      ruleId: ruleId(i + 1),
      hash: HASH_A,
      runId: 'seed',
      at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
    }))
    writeLedgerFile(root, { version: 2, entries: [], coverage: seeded })

    publish(
      root,
      'run-new',
      selectionUpdate(
        'run-new',
        SEL_A,
        [30_001, 30_002, 30_003],
        [30_001, 30_002, 30_003],
      ),
    )

    const kept = coverageOf(root)
    expect(kept).toHaveLength(cap)
    const ids = new Set(kept.map((item) => item.ruleId))
    for (const n of [1, 2, 3]) expect(ids.has(ruleId(n))).toBe(false)
    expect(ids.has(ruleId(4))).toBe(true)
    expect(kept.filter((item) => item.selection === SEL_A)).toHaveLength(3)
  })

  it('removes every selection with the ledger', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    publish(root, 'run-two', selectionUpdate('run-two', SEL_A, [1], [1]))

    expect(clearLedger(root, { pid: 7001, processes: PROCS })).toEqual({
      status: 'cleared',
      removed: true,
    })
    expect(coverageOf(root)).toEqual([])
  })
})

// ── Ledger version 2 ────────────────────────────────────────────────────────

const V1_ENTRY = {
  id: 'cand-1',
  kind: 'transferable-lesson',
  target: '/p/alpha',
  ruleId: ruleId(1),
  sources: [
    { role: 'solution', path: 'docs/solutions/a.md', fingerprint: HASH_A },
  ],
  targetEvidence: [{ path: 'src/x.ts', fingerprint: HASH_B }],
  status: 'candidate' as const,
  history: [],
  recordedAt: '2026-10-01T00:00:00.000Z',
}

const V1_COVERAGE = [
  {
    ruleId: ruleId(1),
    hash: HASH_A,
    runId: 'run-old',
    at: '2026-10-01T00:00:00.000Z',
  },
  {
    ruleId: ruleId(2),
    hash: HASH_A,
    runId: 'run-old',
    at: '2026-10-01T00:00:00.000Z',
    project: 'aaaaaaaaaaaa',
  },
]

function versionOneLedger(): Record<string, unknown> {
  return { version: 1, entries: [V1_ENTRY], coverage: V1_COVERAGE }
}

function ledgerOnDisk(root: string): {
  version: unknown
  entries: unknown
  coverage?: unknown
} {
  return JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'))
}

describe('ledger version 2', () => {
  it('reads a version 1 ledger with its coverage as the no-selection namespace', () => {
    const root = newRoot()
    writeLedgerFile(root, versionOneLedger())

    const read = readLedger(root)
    if (read.status !== 'ok') throw new Error(`ledger ${read.reason}`)
    expect(read.ledger.version).toBe(2)
    expect(read.ledger.entries).toEqual([V1_ENTRY])
    expect(read.ledger.coverage).toEqual(V1_COVERAGE)
    expect(
      read.ledger.coverage?.every((item) => item.selection === undefined),
    ).toBe(true)
  })

  it('writes a new ledger as version 2', () => {
    const root = newRoot()
    publish(root, 'run-one', update('run-one', [1], [1]))
    expect(ledgerOnDisk(root).version).toBe(2)
  })

  it('migrates a version 1 ledger on the first publish and keeps its entries and coverage as they were', () => {
    const root = newRoot()
    writeLedgerFile(root, versionOneLedger())

    publish(root, 'run-new', update('run-new', [1, 2, 3], [3]))

    const after = ledgerOnDisk(root)
    expect(after.version).toBe(2)
    expect(after.entries).toEqual([V1_ENTRY])
    const byRule = new Map(coverageOf(root).map((c) => [c.ruleId, c]))
    expect(byRule.get(ruleId(1))).toEqual(V1_COVERAGE[0])
    expect(byRule.get(ruleId(2))).toEqual(V1_COVERAGE[1])
    expect(byRule.get(ruleId(3))?.runId).toBe('run-new')
  })

  it('migrates a version 1 ledger when a decision is recorded', () => {
    const root = newRoot()
    writeLedgerFile(root, versionOneLedger())

    const decided = decideLedgerEntry(
      root,
      { id: 'cand-1', status: 'rejected', reason: 'not a fit' },
      { pid: 7001, processes: PROCS },
    )

    expect(decided.status).toBe('decided')
    const after = ledgerOnDisk(root)
    expect(after.version).toBe(2)
    expect(after.coverage).toEqual(V1_COVERAGE)
  })

  it('leaves a version 1 ledger as it was when the run dies before the ledger is rewritten, and migrates on the next run', () => {
    const root = newRoot()
    const before = writeLedgerFile(root, versionOneLedger())

    expect(() =>
      publish(root, 'run-one', update('run-one', [3], [3]), {
        afterCommit: () => {
          throw new Error('crash')
        },
      }),
    ).toThrow('crash')
    expect(fs.readFileSync(ledgerPath(root), 'utf8')).toBe(before)

    publish(root, 'run-two', update('run-two', [1, 2, 3], [3]))
    expect(ledgerOnDisk(root).version).toBe(2)
    expect(coverageOf(root).map((item) => item.ruleId)).toEqual([
      ruleId(1),
      ruleId(2),
      ruleId(3),
    ])
  })

  it('leaves a version 1 ledger as it was when the rename of the new ledger fails', () => {
    const root = newRoot()
    const before = writeLedgerFile(root, versionOneLedger())
    const real = fs.renameSync
    const spy = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('ledger.json')) throw new Error('rename failed')
      real(from, to)
    })
    let result: ReturnType<typeof publish>
    try {
      result = publish(root, 'run-one', update('run-one', [3], [3]))
    } finally {
      spy.mockRestore()
    }

    expect(result).toMatchObject({
      status: 'published',
      ledger: { written: false },
    })
    expect(fs.readFileSync(ledgerPath(root), 'utf8')).toBe(before)
    expect(fs.readdirSync(root).sort()).toEqual(['ledger.json', 'runs'])
  })

  it('reads the same rule in two selections, and a duplicate within one selection as unreadable', () => {
    const root = newRoot()
    const base = { hash: HASH_A, runId: 'r', at: 't' }
    writeLedgerFile(root, {
      version: 2,
      entries: [],
      coverage: [
        { ruleId: ruleId(1), ...base },
        { ruleId: ruleId(1), ...base, selection: SEL_A },
        { ruleId: ruleId(1), ...base, selection: SEL_B },
      ],
    })
    expect(coverageOf(root)).toHaveLength(3)

    writeLedgerFile(root, {
      version: 2,
      entries: [],
      coverage: [
        { ruleId: ruleId(1), ...base, selection: SEL_A },
        { ruleId: ruleId(1), ...base, selection: SEL_A },
      ],
    })
    expect(readLedger(root)).toEqual({
      status: 'unreadable',
      reason: 'invalid',
    })
  })

  it.each([
    ['uppercase hex', 'A1B2C3D4E5F60718'],
    ['too short', 'abc'],
    ['not hex', 'g'.repeat(16)],
    ['empty', ''],
    ['a number', 7],
  ])(
    'reads a record with a selection that is %s as unreadable',
    (_name, selection) => {
      const root = newRoot()
      writeLedgerFile(root, {
        version: 2,
        entries: [],
        coverage: [
          { ruleId: ruleId(1), hash: HASH_A, runId: 'r', at: 't', selection },
        ],
      })
      expect(readLedger(root)).toEqual({
        status: 'unreadable',
        reason: 'invalid',
      })
    },
  )

  it.each([
    ['version 3', '{"version":3,"entries":[]}'],
    ['version 0', '{"version":0,"entries":[]}'],
    ['a string version', '{"version":"2","entries":[]}'],
    ['no version', '{"entries":[]}'],
    ['malformed json', '{"version":2,'],
  ])(
    'reads %s as unreadable, and a publish writes nothing and leaves the file as it was',
    (_name, text) => {
      const root = newRoot()
      fs.writeFileSync(ledgerPath(root), text)

      expect(readLedger(root)).toEqual({
        status: 'unreadable',
        reason: 'invalid',
      })
      expect(publish(root, 'run-one', update('run-one', [1], [1]))).toEqual({
        status: 'failed',
        reason: 'ledger-unreadable',
      })
      expect(fs.readFileSync(ledgerPath(root), 'utf8')).toBe(text)
      expect(fs.existsSync(path.join(root, 'runs', 'run-one'))).toBe(false)
    },
  )

  it('reads an oversize file as unreadable and leaves it as it was', () => {
    const root = newRoot()
    const text = `{"version":2,"entries":[],"pad":"${'x'.repeat(16 * 1024 * 1024)}"}`
    fs.writeFileSync(ledgerPath(root), text)

    expect(readLedger(root)).toEqual({
      status: 'unreadable',
      reason: 'too-large',
    })
    expect(publish(root, 'run-one', update('run-one', [1], [1]))).toEqual({
      status: 'failed',
      reason: 'ledger-unreadable',
    })
    expect(fs.statSync(ledgerPath(root)).size).toBe(Buffer.byteLength(text))
  })
})
