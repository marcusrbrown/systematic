/**
 * A helper process that dies while it publishes. The child here is a real
 * process: it takes the real run lock, stages a run and is killed with SIGKILL
 * at one of the two points where a crash leaves something behind. The next run
 * is this test process, using the same state functions the helper uses, with
 * the real process table.
 *
 * Window one: the run is staged in `runs/<id>.tmp/` and the rename has not
 * happened. Nothing is committed, so the next run removes the leftover and
 * proposes the candidate as new.
 *
 * Window two: the rename committed the run and the ledger has not been
 * rewritten. The run stays, the ledger does not know the candidate, and the
 * next run proposes it once more; after that it is suppressed.
 *
 * Window three: the run is committed, the new ledger is written to a
 * temporary file, and the rename that would replace the old ledger has not
 * happened. A version 1 ledger is still version 1 and still whole, and the next
 * run migrates it.
 *
 * What this does not show: a host that kills the helper's process group.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  acquireLock,
  type CandidateRecord,
  type CandidateStanding,
  prepareStateRoot,
  pruneRuns,
  publishRun,
  readLedger,
  releaseLock,
} from '../../src/lib/connect-state.js'
import { cleanupTempDirs, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

const STATE_MODULE = path.resolve(
  import.meta.dirname,
  '../../src/lib/connect-state.ts',
)

const CANDIDATE: CandidateRecord = {
  kind: 'transferable-lesson',
  target: '/projects/target',
  ruleId: 'rule-1',
  sources: [
    { role: 'source@alpha', path: 'docs/solutions/a.md', fingerprint: 'aaa' },
  ],
  targetEvidence: [{ path: 'src/lock.ts', fingerprint: 't1' }],
}

const FILES = { 'digest.md': '# digest\n', 'run.json': '{}\n' }

/** The child: take the lock, then publish with a hook that kills the process at the chosen window. */
const CHILD_SOURCE = `
import fs from 'node:fs'
import { acquireLock, publishRun } from ${JSON.stringify(STATE_MODULE)}

const [root, window, runId] = process.argv.slice(2)
const acquired = acquireLock(root)
if (acquired.status !== 'acquired') process.exit(3)
const die = () => process.kill(process.pid, 'SIGKILL')
if (window === 'ledger-rename') {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('ledger.json')) die()
    return rename(from, to)
  }
}
publishRun(
  root,
  acquired.lock,
  {
    runId,
    files: ${JSON.stringify(FILES)},
    candidates: [${JSON.stringify(CANDIDATE)}],
  },
  {
    hooks: {
      beforeCommit: window === 'before-commit' ? die : undefined,
      afterCommit: window === 'after-commit' ? die : undefined,
    },
  },
)
// Reaching here means the window was never hit.
process.exit(0)
`

function newRoot(): string {
  const result = prepareStateRoot(
    path.join(makeDir('connect-kill-'), 'state'),
    {
      allowedRoots: [],
    },
  )
  if (result.status !== 'ok') throw new Error(`state root ${result.reason}`)
  return result.root
}

/** Run the child to its death and return how it ended. */
function killChildAt(
  root: string,
  window: 'before-commit' | 'after-commit' | 'ledger-rename',
  runId: string,
): { signal: NodeJS.Signals | null; status: number | null; pid: number } {
  const script = path.join(makeDir('connect-kill-script-'), 'child.ts')
  fs.writeFileSync(script, CHILD_SOURCE)
  const child = spawnSync(process.execPath, [script, root, window, runId], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (child.pid === undefined) throw new Error('the child did not start')
  return { signal: child.signal, status: child.status, pid: child.pid }
}

/** The next run: take the lock, reclaim a dead holder, prune, and publish the same candidate. */
function nextRun(root: string, runId: string) {
  const acquired = acquireLock(root)
  if (acquired.status !== 'acquired') {
    throw new Error(`next run could not take the lock: ${acquired.status}`)
  }
  try {
    const pruned = pruneRuns(root, acquired.lock)
    const published = publishRun(root, acquired.lock, {
      runId,
      files: FILES,
      candidates: [CANDIDATE],
    })
    return { acquired, pruned, published }
  } finally {
    releaseLock(acquired.lock)
  }
}

function standings(
  result: ReturnType<typeof publishRun>,
): CandidateStanding['standing'][] {
  if (result.status !== 'published') {
    throw new Error(`publish failed: ${result.reason}`)
  }
  return result.outcomes.map((outcome) => outcome.standing)
}

function ledgerCount(root: string): number {
  const ledger = readLedger(root)
  if (ledger.status !== 'ok') throw new Error(`ledger ${ledger.reason}`)
  return ledger.ledger.entries.length
}

describe('a helper killed while it publishes', () => {
  it('discards the staged run on the next run and proposes the candidate as new', () => {
    const root = newRoot()

    const dead = killChildAt(root, 'before-commit', 'run-1')

    // The child really died by signal, and not by finishing or failing.
    expect(dead.signal).toBe('SIGKILL')
    expect(dead.status).toBeNull()
    // The run was staged and never committed; the lock is still on disk.
    expect(
      fs.existsSync(path.join(root, 'runs', 'run-1.tmp', 'digest.md')),
    ).toBe(true)
    expect(fs.existsSync(path.join(root, 'runs', 'run-1'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'lock'))).toBe(true)

    const next = nextRun(root, 'run-2')

    // The dead holder's lock was reclaimed because that process is gone.
    expect(next.acquired.reclaimed).toMatchObject({
      reason: 'holder-dead',
      previousPid: dead.pid,
    })
    expect(next.pruned).toMatchObject({
      status: 'pruned',
      removedStaging: ['run-1.tmp'],
    })
    expect(standings(next.published)).toEqual(['new'])
    expect(fs.readdirSync(path.join(root, 'runs'))).toEqual(['run-2'])
    expect(ledgerCount(root)).toBe(1)
  })

  it('keeps the committed run when the kill comes after the rename, and proposes the candidate once more', () => {
    const root = newRoot()

    const dead = killChildAt(root, 'after-commit', 'run-1')

    expect(dead.signal).toBe('SIGKILL')
    // The rename committed the run, and the ledger does not know the candidate.
    expect(fs.existsSync(path.join(root, 'runs', 'run-1', 'run.json'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(root, 'runs', 'run-1.tmp'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false)

    const second = nextRun(root, 'run-2')

    expect(second.acquired.reclaimed).toMatchObject({
      reason: 'holder-dead',
      previousPid: dead.pid,
    })
    // Pruning leaves a committed run alone.
    expect(second.pruned).toMatchObject({ removedStaging: [], removedRuns: [] })
    expect(standings(second.published)).toEqual(['new'])
    expect(ledgerCount(root)).toBe(1)

    // Once the ledger holds it, the same candidate is not proposed again.
    const third = nextRun(root, 'run-3')
    expect(third.acquired.reclaimed).toBeUndefined()
    expect(standings(third.published)).toEqual(['suppressed'])
    expect(ledgerCount(root)).toBe(1)
    expect(fs.readdirSync(path.join(root, 'runs')).sort()).toEqual([
      'run-1',
      'run-2',
      'run-3',
    ])
  })

  it('keeps a version 1 ledger whole when the kill comes before its replacement is renamed, and migrates it on the next run', () => {
    const root = newRoot()
    const coverage = {
      ruleId: 'rule-0000000000000001',
      hash: 'a'.repeat(64),
      runId: 'run-0',
      at: '2026-10-01T00:00:00.000Z',
    }
    const before = `${JSON.stringify({ version: 1, entries: [], coverage: [coverage] }, null, 2)}\n`
    fs.writeFileSync(path.join(root, 'ledger.json'), before)

    const dead = killChildAt(root, 'ledger-rename', 'run-1')

    expect(dead.signal).toBe('SIGKILL')
    expect(fs.existsSync(path.join(root, 'runs', 'run-1', 'run.json'))).toBe(
      true,
    )
    expect(fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')).toBe(before)

    const next = nextRun(root, 'run-2')

    expect(standings(next.published)).toEqual(['new'])
    const migrated = JSON.parse(
      fs.readFileSync(path.join(root, 'ledger.json'), 'utf8'),
    ) as { version: number; coverage: unknown[] }
    expect(migrated.version).toBe(2)
    expect(migrated.coverage).toEqual([coverage])
  })
})
