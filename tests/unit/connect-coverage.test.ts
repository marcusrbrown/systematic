import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  planOffer,
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
