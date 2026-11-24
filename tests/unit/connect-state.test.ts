import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  acquireLock,
  type CandidateRecord,
  type CandidateStanding,
  CI_RUN_FILE,
  candidateIdentity,
  classifyCandidate,
  clearLedger,
  decideLedgerEntry,
  type EvidenceLookup,
  type EvidenceNow,
  forceUnlock,
  HOLDERLESS_LOCK_MAX_AGE_MS,
  INVOCATION_FILE,
  type InvocationRecord,
  type LockHandle,
  type LockOptions,
  type LockResult,
  newRunId,
  type ProcessTable,
  parseLinuxStartTime,
  prepareStateRoot,
  processStartTime,
  pruneRuns,
  publishRun,
  RUN_RETENTION_MS,
  readCiRunMarker,
  readInvocationRecord,
  readLedger,
  releaseLock,
  revisionOf,
  revisionOfCandidate,
  rewriteRunFiles,
  writeInvocationRecord,
} from '../../src/lib/connect-state.js'
import { cleanupTempDirs, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

const IS_ROOT = process.getuid?.() === 0
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A process table where a pid in `alive` is running; its value is the start time (undefined = unreadable). */
function fakeProcesses(initial: Record<number, string | undefined> = {}): {
  readonly table: ProcessTable
  readonly alive: Map<number, string | undefined>
} {
  const alive = new Map<number, string | undefined>(
    Object.entries(initial).map(([pid, start]) => [Number(pid), start]),
  )
  return {
    alive,
    table: {
      isAlive: (pid) => alive.has(pid),
      startTime: (pid) => alive.get(pid),
    },
  }
}

function newRoot(allowedRoots: readonly string[] = []): string {
  const result = prepareStateRoot(
    path.join(makeDir('connect-state-'), 'state'),
    {
      allowedRoots,
    },
  )
  if (result.status !== 'ok') throw new Error(`state root ${result.reason}`)
  return result.root
}

function expectAcquired(result: LockResult): LockHandle {
  if (result.status !== 'acquired') {
    throw new Error(`lock ${result.status}: ${JSON.stringify(result)}`)
  }
  return result.lock
}

function mode(target: string): number {
  return fs.lstatSync(target).mode & 0o777
}

function readHolder(root: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'lock', 'holder.json'), 'utf8'),
  )
}

function lockOptions(
  procs: ReturnType<typeof fakeProcesses>,
  pid: number,
  extra: Partial<LockOptions> = {},
): LockOptions {
  return { pid, processes: procs.table, ...extra }
}

function candidate(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    kind: 'contradiction',
    target: '/projects/target',
    ruleId: 'rule-1',
    sources: [
      { role: 'solution', path: 'docs/solutions/a.md', fingerprint: 'aaa' },
    ],
    targetEvidence: [{ path: 'src/x.ts', fingerprint: 't1' }],
    ...over,
  }
}

interface Session {
  readonly root: string
  readonly procs: ReturnType<typeof fakeProcesses>
  readonly clock: { now: number }
  publish(
    runId: string,
    candidates: readonly CandidateRecord[],
    hooks?: { afterCommit?: () => void },
    evidence?: EvidenceLookup,
  ): ReturnType<typeof publishRun>
}

/** A state root plus a helper that locks, publishes and releases like one run. */
function session(): Session {
  const root = newRoot()
  const procs = fakeProcesses({ 7001: 'self' })
  const clock = { now: Date.UTC(2026, 10, 1) }
  return {
    root,
    procs,
    clock,
    publish(runId, candidates, hooks, evidence) {
      const lock = expectAcquired(
        acquireLock(root, {
          pid: 7001,
          processes: procs.table,
          now: () => clock.now,
        }),
      )
      try {
        return publishRun(
          root,
          lock,
          {
            runId,
            files: { 'digest.md': '# digest\n', 'run.json': '{}\n' },
            candidates,
            ...(evidence === undefined ? {} : { evidence }),
          },
          { now: () => clock.now, hooks },
        )
      } finally {
        releaseLock(lock)
      }
    },
  }
}

function publishedOutcomes(
  result: ReturnType<typeof publishRun>,
): readonly CandidateStanding[] {
  if (result.status !== 'published') {
    throw new Error(`publish failed: ${result.reason}`)
  }
  return result.outcomes
}

function ledgerEntries(root: string) {
  const ledger = readLedger(root)
  if (ledger.status !== 'ok') throw new Error(`ledger ${ledger.reason}`)
  return ledger.ledger.entries
}

function ageDirectory(dir: string, ageMs: number, now: number): void {
  const at = new Date(now - ageMs)
  fs.utimesSync(dir, at, at)
}

// ── State root ──────────────────────────────────────────────────────────────

describe('state root', () => {
  it('creates the root and the runs directory at 0700', () => {
    const root = newRoot()
    expect(mode(root)).toBe(0o700)
    expect(mode(path.join(root, 'runs'))).toBe(0o700)
  })

  it('tightens an existing world-readable root and reports it', () => {
    const base = makeDir('connect-state-')
    const root = path.join(base, 'state')
    fs.mkdirSync(root, { mode: 0o755 })
    fs.chmodSync(root, 0o755)
    const result = prepareStateRoot(root, { allowedRoots: [] })
    expect(result).toMatchObject({ status: 'ok', tightened: true })
    expect(mode(root)).toBe(0o700)
  })

  it('refuses a root that is a symlink', () => {
    const base = makeDir('connect-state-')
    const real = path.join(base, 'real')
    fs.mkdirSync(real)
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    expect(prepareStateRoot(link, { allowedRoots: [] })).toEqual({
      status: 'refused',
      reason: 'symlink',
    })
  })

  it('refuses a root that is not a directory', () => {
    const base = makeDir('connect-state-')
    const file = path.join(base, 'file')
    fs.writeFileSync(file, 'x')
    expect(prepareStateRoot(file, { allowedRoots: [] })).toEqual({
      status: 'refused',
      reason: 'not-directory',
    })
  })

  it('refuses a root under a directory that holds a repository', () => {
    const base = makeDir('connect-state-')
    fs.mkdirSync(path.join(base, '.git'))
    fs.writeFileSync(path.join(base, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(
      prepareStateRoot(path.join(base, 'state'), { allowedRoots: [] }),
    ).toEqual({ status: 'refused', reason: 'checkout' })
    expect(fs.existsSync(path.join(base, 'state'))).toBe(false)
  })

  it('refuses a root under a directory that holds a .git file', () => {
    const base = makeDir('connect-state-')
    fs.writeFileSync(path.join(base, '.git'), 'gitdir: /elsewhere\n')
    expect(
      prepareStateRoot(path.join(base, 'state'), { allowedRoots: [] }),
    ).toEqual({ status: 'refused', reason: 'checkout' })
  })

  it('accepts a root under a directory whose .git directory is empty or holds no HEAD', () => {
    const base = makeDir('connect-state-')
    fs.mkdirSync(path.join(base, '.git'))
    const root = path.join(base, 'ws', 'state')
    const result = prepareStateRoot(root, { allowedRoots: [] })
    expect(result.status).toBe('ok')
    expect(fs.existsSync(path.join(root, 'runs'))).toBe(true)
  })

  it('refuses a root that is an allowed root or sits inside one', () => {
    const allowed = makeDir('connect-state-')
    expect(prepareStateRoot(allowed, { allowedRoots: [allowed] })).toEqual({
      status: 'refused',
      reason: 'allowed-root',
    })
    expect(
      prepareStateRoot(path.join(allowed, 'state'), {
        allowedRoots: [allowed],
      }),
    ).toEqual({ status: 'refused', reason: 'allowed-root' })
  })

  it('refuses a runs directory that is a symlink', () => {
    const base = makeDir('connect-state-')
    const root = path.join(base, 'state')
    const elsewhere = path.join(base, 'elsewhere')
    fs.mkdirSync(root, { mode: 0o700 })
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(root, 'runs'))
    expect(prepareStateRoot(root, { allowedRoots: [] })).toEqual({
      status: 'refused',
      reason: 'symlink',
    })
  })
})

// ── Process start time ──────────────────────────────────────────────────────

describe('processStartTime', () => {
  it('reads field 22 of a /proc stat line even when the command name holds a parenthesis', () => {
    const fields = Array.from({ length: 49 }, (_, i) => String(i + 4))
    fields[22 - 4] = '987654'
    const line = `4242 (weird ) name) S ${fields.join(' ')}\n`
    expect(parseLinuxStartTime(line)).toBe('987654')
  })

  it('returns undefined for a stat line it cannot read', () => {
    expect(parseLinuxStartTime('')).toBeUndefined()
    expect(parseLinuxStartTime('1 (x) S 2 3')).toBeUndefined()
    expect(parseLinuxStartTime('garbage')).toBeUndefined()
  })

  it('returns undefined for a pid that is not a positive integer', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(processStartTime(pid)).toBeUndefined()
    }
  })

  const supported =
    process.platform === 'darwin' || process.platform === 'linux'

  it.skipIf(!supported)('reads a stable value for a live process', () => {
    const first = processStartTime(process.pid)
    expect(typeof first).toBe('string')
    expect(first?.length).toBeGreaterThan(0)
    expect(processStartTime(process.pid)).toBe(first)
  })

  it.skipIf(!supported)(
    'returns undefined for a process that has exited',
    () => {
      const child = spawnSync('true')
      expect(child.pid).toBeGreaterThan(0)
      expect(processStartTime(child.pid)).toBeUndefined()
    },
  )
})

// ── Lock ────────────────────────────────────────────────────────────────────

describe('lock', () => {
  it('creates a 0700 directory holding a 0600 holder file with pid, start time and nonce', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 'start-1' })
    const lock = expectAcquired(acquireLock(root, lockOptions(procs, 1001)))

    expect(mode(path.join(root, 'lock'))).toBe(0o700)
    expect(mode(path.join(root, 'lock', 'holder.json'))).toBe(0o600)
    const holder = readHolder(root)
    expect(holder.pid).toBe(1001)
    expect(holder.startTime).toBe('start-1')
    expect(holder.nonce).toBe(lock.nonce)
    expect(String(holder.nonce)).toMatch(/^[0-9a-f-]{36}$/)
    // The holder file was renamed into place; no temp file remains.
    expect(fs.readdirSync(path.join(root, 'lock'))).toEqual(['holder.json'])

    expect(releaseLock(lock)).toBe('released')
    expect(fs.existsSync(path.join(root, 'lock'))).toBe(false)
  })

  it('gives a second run busy with no handle, no artifact and no prune', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1', 1002: 's2' })
    const first = expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    const old = path.join(root, 'runs', 'old-run')
    fs.mkdirSync(old)
    ageDirectory(old, 45 * DAY, Date.now())

    const second = acquireLock(root, lockOptions(procs, 1002))
    expect(second).toEqual({ status: 'busy', reason: 'held' })
    expect('lock' in second).toBe(false)
    // The busy run could not prune, and wrote nothing.
    expect(fs.readdirSync(path.join(root, 'runs'))).toEqual(['old-run'])
    expect(readHolder(root).pid).toBe(1001)
    releaseLock(first)
  })

  it('reclaims a lock whose holder is dead and records it', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1', 1002: 's2' })
    const first = expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    procs.alive.delete(1001)

    const second = acquireLock(root, lockOptions(procs, 1002))
    const lock = expectAcquired(second)
    expect(second).toMatchObject({
      reclaimed: {
        reason: 'holder-dead',
        previousPid: 1001,
        previousNonce: first.nonce,
      },
    })
    expect(readHolder(root).pid).toBe(1002)
    expect(fs.readdirSync(root).sort()).toEqual(['lock', 'runs'])
    expect(releaseLock(lock)).toBe('released')
  })

  it('reclaims a lock whose pid was reused by a process with a different start time', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 'first-start', 1002: 's2' })
    expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    procs.alive.set(1001, 'a-later-start')

    const second = acquireLock(root, lockOptions(procs, 1002))
    expectAcquired(second)
    expect(second).toMatchObject({
      reclaimed: { reason: 'pid-reused', previousPid: 1001 },
    })
  })

  it('is busy when the holder is alive with the same start time', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1', 1002: 's2' })
    expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    expect(acquireLock(root, lockOptions(procs, 1002))).toEqual({
      status: 'busy',
      reason: 'held',
    })
  })

  it('is busy when a live holder start time cannot be read', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1', 1002: 's2' })
    expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    procs.alive.set(1001, undefined)
    expect(acquireLock(root, lockOptions(procs, 1002))).toEqual({
      status: 'busy',
      reason: 'holder-unverifiable',
    })
    expect(readHolder(root).pid).toBe(1001)
  })

  it('is busy when the holder recorded no start time and is still alive', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: undefined, 1002: 's2' })
    expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    expect(readHolder(root).startTime).toBeNull()
    expect(acquireLock(root, lockOptions(procs, 1002))).toEqual({
      status: 'busy',
      reason: 'holder-unverifiable',
    })
    // Once that pid is gone it can be reclaimed.
    procs.alive.delete(1001)
    expectAcquired(acquireLock(root, lockOptions(procs, 1002)))
  })

  describe('holderless lock', () => {
    function holderlessLock(root: string, ageMs: number, now: number): void {
      const dir = path.join(root, 'lock')
      fs.mkdirSync(dir, { mode: 0o700 })
      ageDirectory(dir, ageMs, now)
    }

    it('is busy while newer than ten minutes', () => {
      const root = newRoot()
      const now = Date.now()
      holderlessLock(root, HOLDERLESS_LOCK_MAX_AGE_MS - MINUTE, now)
      const procs = fakeProcesses({ 1002: 's2' })
      expect(
        acquireLock(root, lockOptions(procs, 1002, { now: () => now })),
      ).toEqual({ status: 'busy', reason: 'holderless-recent' })
    })

    it('is reclaimable once ten minutes old', () => {
      const root = newRoot()
      const now = Date.now()
      holderlessLock(root, HOLDERLESS_LOCK_MAX_AGE_MS + 1, now)
      const procs = fakeProcesses({ 1002: 's2' })
      const result = acquireLock(
        root,
        lockOptions(procs, 1002, { now: () => now }),
      )
      expectAcquired(result)
      expect(result).toMatchObject({
        reclaimed: { reason: 'holderless-expired' },
      })
    })

    it('treats an unparseable holder file as no holder', () => {
      const root = newRoot()
      const now = Date.now()
      holderlessLock(root, 0, now)
      fs.writeFileSync(path.join(root, 'lock', 'holder.json'), '{not json')
      ageDirectory(path.join(root, 'lock'), HOLDERLESS_LOCK_MAX_AGE_MS + 1, now)
      const procs = fakeProcesses({ 1002: 's2' })
      const result = acquireLock(
        root,
        lockOptions(procs, 1002, { now: () => now }),
      )
      expectAcquired(result)
      expect(result).toMatchObject({
        reclaimed: { reason: 'holderless-expired' },
      })
    })

    it('restores a fresh lock that replaced the stale one while a reclaimer was deciding', () => {
      const root = newRoot()
      const now = Date.now()
      holderlessLock(root, HOLDERLESS_LOCK_MAX_AGE_MS + MINUTE, now)
      const procs = fakeProcesses({ 1002: 's2' })
      const result = acquireLock(
        root,
        lockOptions(procs, 1002, {
          now: () => now,
          hooks: {
            afterObserve: () => {
              // Another process cleared the stale lock and is mid-acquire.
              fs.rmSync(path.join(root, 'lock'), { recursive: true })
              fs.mkdirSync(path.join(root, 'lock'), { mode: 0o700 })
            },
          },
        }),
      )
      expect(result).toEqual({ status: 'busy', reason: 'reclaim-contended' })
      expect(fs.existsSync(path.join(root, 'lock'))).toBe(true)
      expect(fs.readdirSync(root).sort()).toEqual(['lock', 'runs'])
    })
  })

  describe('two reclaimers race for one stale lock', () => {
    function staleLock(): {
      root: string
      procs: ReturnType<typeof fakeProcesses>
    } {
      const root = newRoot()
      const procs = fakeProcesses({ 1001: 's1', 2001: 'a', 3001: 'b' })
      expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
      procs.alive.delete(1001)
      return { root, procs }
    }

    it('lets the first reclaimer win and leaves its lock intact when the second moves it by mistake', () => {
      const { root, procs } = staleLock()
      let winner: LockResult | undefined
      // B has observed the stale holder when A completes a full reclaim.
      const loser = acquireLock(
        root,
        lockOptions(procs, 3001, {
          hooks: {
            afterObserve: () => {
              winner = acquireLock(root, lockOptions(procs, 2001))
            },
          },
        }),
      )

      expect(loser).toEqual({ status: 'busy', reason: 'reclaim-contended' })
      const held = expectAcquired(winner ?? { status: 'busy', reason: 'held' })
      // B's mistaken rename was undone: A still owns the lock.
      expect(readHolder(root).nonce).toBe(held.nonce)
      expect(readHolder(root).pid).toBe(2001)
      expect(fs.readdirSync(root).sort()).toEqual(['lock', 'runs'])
      expect(releaseLock(held)).toBe('released')
    })

    it('is busy for the second reclaimer when the first has already come and gone', () => {
      const { root, procs } = staleLock()
      const loser = acquireLock(
        root,
        lockOptions(procs, 3001, {
          hooks: {
            afterObserve: () => {
              const first = expectAcquired(
                acquireLock(root, lockOptions(procs, 2001)),
              )
              releaseLock(first)
            },
          },
        }),
      )
      expect(loser).toEqual({ status: 'busy', reason: 'reclaim-contended' })
      expect(fs.existsSync(path.join(root, 'lock'))).toBe(false)
    })

    it('gives exactly one acquisition across both outcomes', () => {
      const { root, procs } = staleLock()
      const results: LockResult[] = []
      results.push(
        acquireLock(
          root,
          lockOptions(procs, 3001, {
            hooks: {
              afterObserve: () => {
                results.push(acquireLock(root, lockOptions(procs, 2001)))
              },
            },
          }),
        ),
      )
      expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'busy')).toHaveLength(1)
    })
  })

  it('does not release a lock it no longer owns', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1', 1002: 's2' })
    const first = expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    procs.alive.delete(1001)
    const second = expectAcquired(acquireLock(root, lockOptions(procs, 1002)))

    expect(releaseLock(first)).toBe('lost')
    expect(readHolder(root).nonce).toBe(second.nonce)
    expect(releaseLock(second)).toBe('released')
    expect(releaseLock(second)).toBe('lost')
  })

  describe('forceUnlock', () => {
    it('clears a live lock and names the holder it removed', () => {
      const root = newRoot()
      const procs = fakeProcesses({ 1001: 's1', 1002: 's2' })
      expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
      expect(forceUnlock(root)).toMatchObject({
        status: 'unlocked',
        holder: { pid: 1001 },
      })
      expect(fs.readdirSync(root).sort()).toEqual(['runs'])
      expectAcquired(acquireLock(root, lockOptions(procs, 1002)))
    })

    it('clears a holderless lock and reports when there is none', () => {
      const root = newRoot()
      expect(forceUnlock(root)).toEqual({ status: 'no-lock' })
      fs.mkdirSync(path.join(root, 'lock'), { mode: 0o700 })
      expect(forceUnlock(root)).toEqual({ status: 'unlocked' })
      expect(fs.existsSync(path.join(root, 'lock'))).toBe(false)
    })

    it('removes a lock path that is a file or a symlink without following it', () => {
      const root = newRoot()
      const outside = makeDir('connect-state-outside-')
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
      fs.symlinkSync(outside, path.join(root, 'lock'))
      expect(forceUnlock(root)).toEqual({ status: 'unlocked' })
      expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'lock'))).toBe(false)
    })
  })

  it('refuses to treat a lock path that is not a directory as a held lock', () => {
    const root = newRoot()
    fs.writeFileSync(path.join(root, 'lock'), 'x')
    const procs = fakeProcesses({ 1002: 's2' })
    expect(acquireLock(root, lockOptions(procs, 1002))).toEqual({
      status: 'failed',
      reason: 'not-a-directory',
    })
  })
})

describe('lock with the real process table', () => {
  const supported =
    process.platform === 'darwin' || process.platform === 'linux'

  it.skipIf(!supported)(
    'is busy for a second acquire in a live process',
    () => {
      const root = newRoot()
      const first = expectAcquired(acquireLock(root))
      expect(acquireLock(root)).toEqual({ status: 'busy', reason: 'held' })
      expect(releaseLock(first)).toBe('released')
    },
  )

  it.skipIf(!supported)(
    'reclaims the lock a crashed process left behind',
    () => {
      const root = newRoot()
      const module = path.resolve(
        import.meta.dirname,
        '../../src/lib/connect-state.ts',
      )
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `import { acquireLock } from ${JSON.stringify(module)};
           const r = acquireLock(process.argv[1]);
           process.exit(r.status === 'acquired' ? 0 : 3)`,
          root,
        ],
        { encoding: 'utf8' },
      )
      expect(child.status).toBe(0)
      // The child exited without releasing, so its lock is still on disk.
      expect(readHolder(root).pid).toBe(child.pid)

      const result = acquireLock(root)
      const lock = expectAcquired(result)
      expect(result).toMatchObject({
        reclaimed: { reason: 'holder-dead', previousPid: child.pid },
      })
      expect(releaseLock(lock)).toBe('released')
    },
  )
})

// ── Run ids ─────────────────────────────────────────────────────────────────

describe('newRunId', () => {
  it('is a safe, sortable, unique name', () => {
    const now = Date.UTC(2026, 10, 7, 12, 30, 45)
    const a = newRunId(now)
    const b = newRunId(now)
    expect(a).toMatch(/^20261107T123045Z-[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
  })
})

// ── Publishing ──────────────────────────────────────────────────────────────

describe('publishRun', () => {
  it('publishes by renaming the staging directory, then rewrites the ledger', () => {
    const s = session()
    const seen: Record<string, boolean> = {}
    const result = s.publish('run-1', [candidate()], {
      afterCommit: () => {
        seen.runExists = fs.existsSync(path.join(s.root, 'runs', 'run-1'))
        seen.stagingGone = !fs.existsSync(
          path.join(s.root, 'runs', 'run-1.tmp'),
        )
        seen.ledgerAbsent = !fs.existsSync(path.join(s.root, 'ledger.json'))
      },
    })

    // At the moment the rename committed, the ledger had not been written.
    expect(seen).toEqual({
      runExists: true,
      stagingGone: true,
      ledgerAbsent: true,
    })
    expect(result).toMatchObject({
      status: 'published',
      ledger: { written: true },
    })
    expect(publishedOutcomes(result).map((o) => o.standing)).toEqual(['new'])

    const runDir = path.join(s.root, 'runs', 'run-1')
    expect(mode(runDir)).toBe(0o700)
    expect(mode(path.join(runDir, 'digest.md'))).toBe(0o600)
    expect(mode(path.join(runDir, 'run.json'))).toBe(0o600)
    expect(fs.readFileSync(path.join(runDir, 'digest.md'), 'utf8')).toBe(
      '# digest\n',
    )
    expect(mode(path.join(s.root, 'ledger.json'))).toBe(0o600)
    expect(
      fs.readdirSync(s.root).filter((name) => name.includes('.tmp')),
    ).toEqual([])
    expect(fs.readdirSync(path.join(s.root, 'runs'))).toEqual(['run-1'])
  })

  it('refuses to publish without the lock and leaves nothing behind', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1' })
    const lock = expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    releaseLock(lock)

    const result = publishRun(root, lock, {
      runId: 'run-1',
      files: { 'digest.md': 'x' },
      candidates: [candidate()],
    })
    expect(result).toEqual({ status: 'failed', reason: 'lock-lost' })
    expect(fs.readdirSync(path.join(root, 'runs'))).toEqual([])
    expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false)
  })

  it('refuses a run id that exists, and one that is not a plain name', () => {
    const s = session()
    expect(s.publish('run-1', []).status).toBe('published')
    expect(s.publish('run-1', [])).toEqual({
      status: 'failed',
      reason: 'run-exists',
    })
    for (const bad of [
      '../escape',
      'a/b',
      '',
      '.hidden',
      'run.tmp',
      'x'.repeat(100),
    ]) {
      expect(s.publish(bad, [])).toEqual({
        status: 'failed',
        reason: 'invalid-run-id',
      })
    }
    expect(fs.readdirSync(path.join(s.root, 'runs'))).toEqual(['run-1'])
  })

  it('refuses a file name that could leave the run directory', () => {
    const root = newRoot()
    const procs = fakeProcesses({ 1001: 's1' })
    const lock = expectAcquired(acquireLock(root, lockOptions(procs, 1001)))
    for (const name of ['../x', 'a/b', '', '.', '..', 'x\0y']) {
      const result = publishRun(root, lock, {
        runId: 'run-1',
        files: { [name]: 'x' },
        candidates: [],
      })
      expect(result).toEqual({ status: 'failed', reason: 'invalid-file-name' })
    }
    expect(fs.readdirSync(path.join(root, 'runs'))).toEqual([])
    releaseLock(lock)
  })

  it('refuses a malformed candidate before anything is written', () => {
    const s = session()
    expect(s.publish('run-1', [candidate({ ruleId: '' })])).toEqual({
      status: 'failed',
      reason: 'invalid-candidate',
    })
    expect(s.publish('run-2', [candidate({ sources: [] })])).toEqual({
      status: 'failed',
      reason: 'invalid-candidate',
    })
    expect(fs.readdirSync(path.join(s.root, 'runs'))).toEqual([])
  })

  it('fails without publishing when the ledger cannot be read', () => {
    const s = session()
    fs.writeFileSync(path.join(s.root, 'ledger.json'), '{broken', {
      mode: 0o600,
    })
    expect(s.publish('run-1', [candidate()])).toEqual({
      status: 'failed',
      reason: 'ledger-unreadable',
    })
    expect(fs.readdirSync(path.join(s.root, 'runs'))).toEqual([])
    expect(fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')).toBe(
      '{broken',
    )
  })

  it('leaves a committed run when the process dies before the ledger rewrite, and re-proposes once', () => {
    const s = session()
    expect(() =>
      s.publish('run-1', [candidate()], {
        afterCommit: () => {
          throw new Error('simulated crash')
        },
      }),
    ).toThrow('simulated crash')

    expect(fs.existsSync(path.join(s.root, 'runs', 'run-1'))).toBe(true)
    expect(fs.existsSync(path.join(s.root, 'ledger.json'))).toBe(false)

    // The next run does not see the candidate in the ledger, so it proposes it again.
    const second = s.publish('run-2', [candidate()])
    expect(publishedOutcomes(second).map((o) => o.standing)).toEqual(['new'])
    // After that publish completes, the candidate is suppressed.
    const third = s.publish('run-3', [candidate()])
    expect(publishedOutcomes(third).map((o) => o.standing)).toEqual([
      'suppressed',
    ])
  })

  it.skipIf(IS_ROOT)(
    'reports a ledger write failure after the commit instead of undoing the run',
    () => {
      const s = session()
      const lock = expectAcquired(
        acquireLock(s.root, { pid: 7001, processes: s.procs.table }),
      )
      const result = publishRun(
        s.root,
        lock,
        {
          runId: 'run-1',
          files: { 'digest.md': 'x' },
          candidates: [candidate()],
        },
        { hooks: { afterCommit: () => fs.chmodSync(s.root, 0o500) } },
      )
      fs.chmodSync(s.root, 0o700)
      releaseLock(lock)
      expect(result).toMatchObject({
        status: 'published',
        ledger: { written: false },
      })
      expect(fs.existsSync(path.join(s.root, 'runs', 'run-1'))).toBe(true)
      expect(fs.existsSync(path.join(s.root, 'ledger.json'))).toBe(false)
    },
  )
})

// ── Candidate identity ──────────────────────────────────────────────────────

describe('candidateIdentity', () => {
  it('ignores source order, duplicate sources and a leading ./', () => {
    const a = candidate({
      sources: [
        { role: 'solution', path: 'docs/solutions/a.md', fingerprint: '1' },
        { role: 'code', path: 'src/b.ts', fingerprint: '2' },
      ],
    })
    const b = candidate({
      sources: [
        { role: 'code', path: './src/b.ts', fingerprint: '2' },
        { role: 'solution', path: 'docs/solutions/a.md', fingerprint: '1' },
        { role: 'solution', path: 'docs/solutions/a.md', fingerprint: '1' },
      ],
    })
    expect(candidateIdentity(a)).toBe(candidateIdentity(b))
  })

  it('ignores fingerprints and target evidence', () => {
    expect(candidateIdentity(candidate())).toBe(
      candidateIdentity(
        candidate({
          sources: [
            {
              role: 'solution',
              path: 'docs/solutions/a.md',
              fingerprint: 'zzz',
            },
          ],
          targetEvidence: [],
        }),
      ),
    )
  })

  it('differs by kind, target, role, path and rule id', () => {
    const base = candidateIdentity(candidate())
    const variants = [
      candidate({ kind: 'lesson' }),
      candidate({ target: '/projects/other' }),
      candidate({ ruleId: 'rule-2' }),
      candidate({
        sources: [
          { role: 'plan', path: 'docs/solutions/a.md', fingerprint: 'aaa' },
        ],
      }),
      candidate({
        sources: [
          { role: 'solution', path: 'docs/solutions/b.md', fingerprint: 'aaa' },
        ],
      }),
    ]
    const ids = variants.map(candidateIdentity)
    expect(new Set([base, ...ids]).size).toBe(variants.length + 1)
  })
})

// ── Ledger suppression ──────────────────────────────────────────────────────

describe('ledger', () => {
  it('proposes nothing on a second pass over unchanged fingerprints, and reopens when a source changes', () => {
    const s = session()
    expect(
      publishedOutcomes(s.publish('run-1', [candidate()])).map(
        (o) => o.standing,
      ),
    ).toEqual(['new'])
    expect(
      publishedOutcomes(s.publish('run-2', [candidate()])).map(
        (o) => o.standing,
      ),
    ).toEqual(['suppressed'])

    const changed = candidate({
      sources: [
        { role: 'solution', path: 'docs/solutions/a.md', fingerprint: 'bbb' },
      ],
    })
    const outcomes = publishedOutcomes(s.publish('run-3', [changed]))
    expect(outcomes).toMatchObject([
      {
        standing: 'reopened',
        reason: 'sources changed',
        priorStatus: 'candidate',
      },
    ])

    const [entry] = ledgerEntries(s.root)
    expect(entry).toMatchObject({
      status: 'candidate',
      reopened: 'sources changed',
      sources: [{ fingerprint: 'bbb' }],
    })
    // History keeps the state the entry had before it reopened.
    expect(entry?.history).toHaveLength(1)
    expect(entry?.history[0]).toMatchObject({
      status: 'candidate',
      sources: [{ fingerprint: 'aaa' }],
    })

    // The reopened entry is itself suppressed on the next unchanged pass.
    expect(
      publishedOutcomes(s.publish('run-4', [changed])).map((o) => o.standing),
    ).toEqual(['suppressed'])
  })

  it('reopens as "target changed" when a target-evidence fingerprint changes', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const outcomes = publishedOutcomes(
      s.publish('run-2', [
        candidate({
          targetEvidence: [{ path: 'src/x.ts', fingerprint: 't2' }],
        }),
      ]),
    )
    expect(outcomes).toMatchObject([
      { standing: 'reopened', reason: 'target changed' },
    ])
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      reopened: 'target changed',
      targetEvidence: [{ path: 'src/x.ts', fingerprint: 't2' }],
    })
  })

  it('compares target evidence only on paths both runs cite', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const outcomes = publishedOutcomes(
      s.publish('run-2', [
        candidate({
          targetEvidence: [
            { path: 'src/x.ts', fingerprint: 't1' },
            { path: 'src/new.ts', fingerprint: 'n1' },
          ],
        }),
      ]),
    )
    expect(outcomes.map((o) => o.standing)).toEqual(['suppressed'])
    expect(
      publishedOutcomes(
        s.publish('run-3', [
          candidate({
            targetEvidence: [{ path: 'src/other.ts', fingerprint: 'o' }],
          }),
        ]),
      ).map((o) => o.standing),
    ).toEqual(['suppressed'])
  })

  it('suppresses an unchanged candidate whatever its status', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const [entry] = ledgerEntries(s.root)
    const id = entry?.id ?? ''

    const decided = decideLedgerEntry(
      s.root,
      { id, status: 'rejected', reason: 'context-specific, no write needed' },
      { pid: 7001, processes: s.procs.table },
    )
    expect(decided.status).toBe('decided')
    expect(publishedOutcomes(s.publish('run-2', [candidate()]))).toMatchObject([
      { standing: 'suppressed', priorStatus: 'rejected' },
    ])

    decideLedgerEntry(
      s.root,
      {
        id,
        status: 'promoted',
        reason: 'recorded',
        destination: 'docs/solutions/x.md',
      },
      { pid: 7001, processes: s.procs.table },
    )
    expect(publishedOutcomes(s.publish('run-3', [candidate()]))).toMatchObject([
      { standing: 'suppressed', priorStatus: 'promoted' },
    ])
  })

  it('adds a refresh pointer when a promoted candidate sources change', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    decideLedgerEntry(
      s.root,
      {
        id,
        status: 'promoted',
        reason: 'recorded',
        destination: 'docs/solutions/x.md',
      },
      { pid: 7001, processes: s.procs.table },
    )

    const outcomes = publishedOutcomes(
      s.publish('run-2', [
        candidate({
          sources: [
            {
              role: 'solution',
              path: 'docs/solutions/a.md',
              fingerprint: 'new',
            },
          ],
        }),
      ]),
    )
    expect(outcomes).toMatchObject([
      {
        standing: 'reopened',
        reason: 'sources changed',
        priorStatus: 'promoted',
        refreshPointer: 'docs/solutions/x.md',
      },
    ])
    const [entry] = ledgerEntries(s.root)
    expect(entry?.status).toBe('candidate')
    expect(entry?.history[0]).toMatchObject({
      status: 'promoted',
      destination: 'docs/solutions/x.md',
    })
  })

  it('keeps two lessons from the same files with different rule ids apart', () => {
    const s = session()
    const outcomes = publishedOutcomes(
      s.publish('run-1', [
        candidate({ ruleId: 'rule-1' }),
        candidate({ ruleId: 'rule-2' }),
      ]),
    )
    expect(outcomes.map((o) => o.standing)).toEqual(['new', 'new'])
    const entries = ledgerEntries(s.root)
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((e) => e.id)).size).toBe(2)
  })

  it('does not match a renamed source path automatically, but points at the old entry', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const oldId = ledgerEntries(s.root)[0]?.id

    const renamed = candidate({
      sources: [
        {
          role: 'solution',
          path: 'docs/solutions/renamed.md',
          fingerprint: 'aaa',
        },
      ],
    })
    const outcomes = publishedOutcomes(s.publish('run-2', [renamed]))
    expect(outcomes).toMatchObject([
      { standing: 'new', possibleMatches: [oldId] },
    ])
    expect(ledgerEntries(s.root)).toHaveLength(2)
  })

  it('treats a missing source as unresolved, not changed, and records nothing', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const before = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')

    const outcomes = publishedOutcomes(
      s.publish('run-2', [
        candidate({
          sources: [
            {
              role: 'solution',
              path: 'docs/solutions/a.md',
              fingerprint: undefined,
            },
          ],
        }),
      ]),
    )
    expect(outcomes).toMatchObject([
      { standing: 'unresolved', missing: ['docs/solutions/a.md'] },
    ])
    expect(fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')).toBe(
      before,
    )
  })

  it('classifies without writing', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const ledger = readLedger(s.root)
    if (ledger.status !== 'ok') throw new Error('ledger unreadable')
    expect(classifyCandidate(ledger.ledger, candidate())).toMatchObject({
      standing: 'suppressed',
    })
    expect(
      classifyCandidate(ledger.ledger, candidate({ ruleId: 'other' })),
    ).toMatchObject({ standing: 'new' })
  })

  it('still suppresses after the run directory is pruned at day 45, and show lists the open candidate', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const runDir = path.join(s.root, 'runs', 'run-1')
    ageDirectory(runDir, 45 * DAY, s.clock.now)

    const lock = expectAcquired(
      acquireLock(s.root, {
        pid: 7001,
        processes: s.procs.table,
        now: () => s.clock.now,
      }),
    )
    expect(pruneRuns(s.root, lock, { now: () => s.clock.now })).toMatchObject({
      status: 'pruned',
      removedRuns: ['run-1'],
    })
    releaseLock(lock)
    expect(fs.existsSync(runDir)).toBe(false)

    const entries = ledgerEntries(s.root)
    expect(entries.map((e) => e.status)).toEqual(['candidate'])
    expect(
      publishedOutcomes(s.publish('run-2', [candidate()])).map(
        (o) => o.standing,
      ),
    ).toEqual(['suppressed'])
  })

  it('returns an empty ledger when none exists, and unreadable for corrupt or oversize content', () => {
    const root = newRoot()
    expect(readLedger(root)).toMatchObject({
      status: 'ok',
      ledger: { version: 2, entries: [] },
    })
    fs.writeFileSync(
      path.join(root, 'ledger.json'),
      '{"version":3,"entries":[]}',
    )
    expect(readLedger(root)).toEqual({
      status: 'unreadable',
      reason: 'invalid',
    })
    fs.writeFileSync(
      path.join(root, 'ledger.json'),
      '{"version":1,"entries":[{"id":1}]}',
    )
    expect(readLedger(root)).toEqual({
      status: 'unreadable',
      reason: 'invalid',
    })
    fs.writeFileSync(path.join(root, 'ledger.json'), 'not json')
    expect(readLedger(root)).toEqual({
      status: 'unreadable',
      reason: 'invalid',
    })
  })

  it('holds no excerpt text for any status', () => {
    const s = session()
    const planted = {
      excerpt: 'PLANTED-EXCERPT-TEXT-ONE',
      claim: 'PLANTED-CLAIM-TEXT-TWO',
      quote: 'PLANTED-QUOTE-TEXT-THREE',
    }
    const noisy: CandidateRecord = { ...candidate(), ...planted }
    s.publish('run-1', [noisy])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    expect(readFileText(path.join(s.root, 'ledger.json'))).not.toMatch(
      /PLANTED/,
    )

    decideLedgerEntry(
      s.root,
      {
        id,
        status: 'promoted',
        reason: 'recorded',
        destination: 'docs/solutions/x.md',
      },
      { pid: 7001, processes: s.procs.table },
    )
    s.publish('run-2', [{ ...noisy, ...planted }])
    expect(readFileText(path.join(s.root, 'ledger.json'))).not.toMatch(
      /PLANTED/,
    )
    decideLedgerEntry(
      s.root,
      { id, status: 'rejected', reason: 'no longer relevant' },
      { pid: 7001, processes: s.procs.table },
    )
    expect(readFileText(path.join(s.root, 'ledger.json'))).not.toMatch(
      /PLANTED/,
    )
  })
})

function readFileText(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

// ── code-mismatch: identity, reopen and ledger fields ───────────────────────

const LEARNING_PROJECT = 'aaaaaaaaaaaa'
const EVIDENCE_PROJECT = 'bbbbbbbbbbbb'
const LEARNING_PATH = 'docs/solutions/a.md'

function mismatch(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    kind: 'code-mismatch',
    target: '/projects/target',
    ruleId: 'rule-1',
    sources: [
      {
        role: `source@${LEARNING_PROJECT}`,
        path: LEARNING_PATH,
        fingerprint: 'L1',
      },
    ],
    targetEvidence: [],
    mismatchReason: 'stale',
    claim: 'claim-1',
    evidence: [
      { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E1' },
    ],
    ...over,
  }
}

/** What the run's inventory says now: files not listed are unread. */
function inventory(files: Record<string, EvidenceNow>): EvidenceLookup {
  return (project, file) => files[`${project}:${file}`] ?? { status: 'unread' }
}

const present = (fingerprint: string): EvidenceNow => ({
  status: 'present',
  fingerprint,
})
const GONE: EvidenceNow = { status: 'gone' }
const EVIDENCE_KEY = `${EVIDENCE_PROJECT}:Caddyfile`

function decide(
  s: Session,
  id: string,
  status: 'promoted' | 'rejected',
  extra: { destination?: string } = {},
) {
  return decideLedgerEntry(
    s.root,
    { id, status, reason: `decided ${status}`, ...extra },
    { pid: 7001, processes: s.procs.table },
  )
}

describe('candidateIdentity for a code-mismatch candidate', () => {
  it('leaves the id of every candidate without the new fields as it was', () => {
    // Pinned from the algorithm before the new fields existed.
    expect(candidateIdentity(candidate())).toBe(
      '192ac5e6e92ec5b669acdd9c356aabeaf37972b6d8c4c2dc183e8776222237d6',
    )
  })

  it('differs by reason and by claim', () => {
    const base = candidateIdentity(mismatch())
    expect(
      candidateIdentity(mismatch({ mismatchReason: 'unscoped' })),
    ).not.toBe(base)
    expect(candidateIdentity(mismatch({ claim: 'claim-2' }))).not.toBe(base)
    const { claim: _claim, ...withoutClaim } = mismatch()
    expect(candidateIdentity(withoutClaim)).not.toBe(base)
  })

  it('never changes with the evidence, the learning bytes or the evidence order', () => {
    const base = candidateIdentity(mismatch())
    expect(
      candidateIdentity(
        mismatch({
          evidence: [
            { project: EVIDENCE_PROJECT, path: 'other.ts', fingerprint: 'X' },
          ],
        }),
      ),
    ).toBe(base)
    expect(candidateIdentity(mismatch({ evidence: [] }))).toBe(base)
    expect(
      candidateIdentity(
        mismatch({
          sources: [
            {
              role: `source@${LEARNING_PROJECT}`,
              path: LEARNING_PATH,
              fingerprint: 'L2',
            },
          ],
        }),
      ),
    ).toBe(base)
  })
})

/**
 * The ledger validation of the shipped helper (v3.35.3, `connect-state.ts` on
 * `origin/main`): an entry or history item is read by its named fields only, a
 * `reopened` value is one of two, and one bad entry makes the whole ledger
 * unreadable. Copied here, not imported, because it is the reader a rollback
 * puts back; this copy must not follow the current reader.
 */
function shippedReaderAccepts(text: string): boolean {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  const plain = (v: unknown, max: number): boolean =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    !/\p{Cc}/u.test(v)
  const optional = (v: unknown, max: number): boolean =>
    v === undefined || plain(v, max)
  const reopened = (v: unknown): boolean =>
    v === undefined || v === 'sources changed' || v === 'target changed'
  const source = (v: unknown): boolean =>
    record(v) &&
    plain(v.role, 512) &&
    plain(v.path, 4096) &&
    plain(v.fingerprint, 128)
  const targetEvidence = (v: unknown): boolean =>
    record(v) && plain(v.path, 4096) && plain(v.fingerprint, 128)
  const status = (v: unknown): boolean =>
    v === 'candidate' || v === 'promoted' || v === 'rejected'
  const shared = (v: Record<string, unknown>): boolean =>
    status(v.status) &&
    optional(v.reason, 500) &&
    optional(v.destination, 4096) &&
    reopened(v.reopened) &&
    Array.isArray(v.sources) &&
    v.sources.every(source) &&
    Array.isArray(v.targetEvidence) &&
    v.targetEvidence.every(targetEvidence) &&
    plain(v.recordedAt, 512)
  const historyItem = (v: unknown): boolean => record(v) && shared(v)
  const entry = (v: unknown): boolean =>
    record(v) &&
    plain(v.id, 512) &&
    plain(v.kind, 512) &&
    plain(v.target, 4096) &&
    plain(v.ruleId, 512) &&
    shared(v) &&
    Array.isArray(v.history) &&
    v.history.every(historyItem)
  try {
    const value: unknown = JSON.parse(text)
    return (
      record(value) &&
      (value.version === 1 || value.version === 2) &&
      Array.isArray(value.entries) &&
      value.entries.every(entry)
    )
  } catch {
    return false
  }
}

describe('a decided code-mismatch candidate', () => {
  it('writes a ledger the shipped reader still loads after an evidence reopen', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    decide(s, id, 'rejected')
    s.publish(
      'run-2',
      [mismatch()],
      undefined,
      inventory({ [EVIDENCE_KEY]: present('E2') }),
    )
    const written = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
    expect(shippedReaderAccepts(written)).toBe(true)
    // The reopen is in the ledger under a value the old reader knows,
    // and its true reason is in a field the old reader ignores.
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      status: 'candidate',
      reopened: 'target changed',
      reopenedFor: 'evidence changed',
    })

    // The next reopen moves it into history, which the old reader reads too.
    decide(s, id, 'rejected')
    s.publish(
      'run-3',
      [mismatch()],
      undefined,
      inventory({ [EVIDENCE_KEY]: present('E3') }),
    )
    const again = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
    expect(shippedReaderAccepts(again)).toBe(true)
    expect(ledgerEntries(s.root)[0]?.history).toHaveLength(2)
  })

  it('keeps reopenedFor on the history item of an entry that is reopened again', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    decide(s, id, 'rejected')
    s.publish(
      'run-2',
      [mismatch()],
      undefined,
      inventory({ [EVIDENCE_KEY]: present('E2') }),
    )
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      reopened: 'target changed',
      reopenedFor: 'evidence changed',
    })

    // The entry was never decided again, so the next reopen (the learning
    // changed) moves the evidence reopen into history as it stood.
    const changedLearning = mismatch({
      sources: [
        {
          role: `source@${LEARNING_PROJECT}`,
          path: LEARNING_PATH,
          fingerprint: 'L2',
        },
      ],
    })
    expect(
      publishedOutcomes(s.publish('run-3', [changedLearning])),
    ).toMatchObject([{ standing: 'reopened', reason: 'sources changed' }])

    const [entry] = ledgerEntries(s.root)
    expect(entry).toMatchObject({ reopened: 'sources changed' })
    expect(entry).not.toHaveProperty('reopenedFor')
    expect(entry?.history).toHaveLength(2)
    expect(entry?.history[1]).toMatchObject({
      status: 'candidate',
      reopened: 'target changed',
      reopenedFor: 'evidence changed',
    })
    const written = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
    expect(shippedReaderAccepts(written)).toBe(true)
  })

  it('does not accept the fixture reader for a value only the current reader knows', () => {
    const entry = {
      id: 'x',
      kind: 'k',
      target: '/t',
      ruleId: 'r',
      sources: [],
      targetEvidence: [],
      status: 'candidate',
      reopened: 'evidence changed',
      history: [],
      recordedAt: '2026-11-12T00:00:00.000Z',
    }
    expect(
      shippedReaderAccepts(JSON.stringify({ version: 2, entries: [entry] })),
    ).toBe(false)
    expect(
      shippedReaderAccepts(
        JSON.stringify({
          version: 2,
          entries: [{ ...entry, reopened: 'target changed' }],
        }),
      ),
    ).toBe(true)
  })

  it('reopens as "evidence changed" when an evidence file in another project changes', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    decide(s, id, 'rejected')

    const outcomes = publishedOutcomes(
      s.publish(
        'run-2',
        [mismatch()],
        undefined,
        inventory({ [EVIDENCE_KEY]: present('E2') }),
      ),
    )
    expect(outcomes).toMatchObject([
      {
        standing: 'reopened',
        reason: 'evidence changed',
        priorStatus: 'rejected',
      },
    ])
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      status: 'candidate',
      reopened: 'target changed',
      reopenedFor: 'evidence changed',
    })
  })

  it("reopens the same way for evidence in the learning's own project", () => {
    const own = {
      project: LEARNING_PROJECT,
      path: 'src/loader.ts',
      fingerprint: 'E1',
    }
    const s = session()
    s.publish('run-1', [mismatch({ evidence: [own] })])
    const outcomes = publishedOutcomes(
      s.publish(
        'run-2',
        [mismatch({ evidence: [own] })],
        undefined,
        inventory({ [`${LEARNING_PROJECT}:src/loader.ts`]: present('E9') }),
      ),
    )
    expect(outcomes).toMatchObject([
      { standing: 'reopened', reason: 'evidence changed' },
    ])
  })

  it('reopens as "evidence changed" when a recorded evidence file is gone', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [mismatch()],
          undefined,
          inventory({ [EVIDENCE_KEY]: GONE }),
        ),
      ),
    ).toMatchObject([{ standing: 'reopened', reason: 'evidence changed' }])
  })

  describe('decided with no evidence recorded', () => {
    function decidedWithoutEvidence(): Session {
      const s = session()
      s.publish('run-1', [mismatch({ evidence: [] })])
      decide(s, ledgerEntries(s.root)[0]?.id ?? '', 'rejected')
      return s
    }

    it('reopens as "evidence changed" when a later proposal brings evidence', () => {
      const s = decidedWithoutEvidence()
      expect(publishedOutcomes(s.publish('run-2', [mismatch()]))).toMatchObject(
        [
          {
            standing: 'reopened',
            reason: 'evidence changed',
            priorStatus: 'rejected',
          },
        ],
      )
      expect(ledgerEntries(s.root)[0]).toMatchObject({
        status: 'candidate',
        reopened: 'target changed',
        reopenedFor: 'evidence changed',
        evidence: [
          { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E1' },
        ],
      })
    })

    it('stays suppressed when the later proposal has no evidence either', () => {
      const s = decidedWithoutEvidence()
      const outcomes = publishedOutcomes(
        s.publish('run-2', [mismatch({ evidence: [] })]),
      )
      expect(outcomes.map((o) => o.standing)).toEqual(['suppressed'])
    })

    it('is suppressed again once the reopened entry records that evidence', () => {
      const s = decidedWithoutEvidence()
      s.publish('run-2', [mismatch()])
      decide(s, ledgerEntries(s.root)[0]?.id ?? '', 'rejected')
      const outcomes = publishedOutcomes(s.publish('run-3', [mismatch()]))
      expect(outcomes.map((o) => o.standing)).toEqual(['suppressed'])
    })
  })

  describe('an open entry published again with other evidence', () => {
    const A = { project: EVIDENCE_PROJECT, path: 'a.conf', fingerprint: 'A1' }
    const B = { project: EVIDENCE_PROJECT, path: 'b.conf', fingerprint: 'B1' }
    const A_KEY = `${EVIDENCE_PROJECT}:a.conf`
    const B_KEY = `${EVIDENCE_PROJECT}:b.conf`

    /** Open with evidence A, then published again citing B, then decided from that. */
    function decidedOnB(): { s: Session; id: string } {
      const s = session()
      s.publish('run-1', [mismatch({ evidence: [A] })])
      const id = ledgerEntries(s.root)[0]?.id ?? ''
      const again = publishedOutcomes(
        s.publish('run-2', [mismatch({ evidence: [B] })]),
      )
      expect(again.map((o) => o.standing)).toEqual(['suppressed'])
      decide(s, id, 'rejected')
      return { s, id }
    }

    it('records the evidence of the run that published it, and nothing else about the entry changes', () => {
      const s = session()
      s.publish('run-1', [mismatch({ evidence: [A] })])
      const [before] = ledgerEntries(s.root)
      s.publish('run-2', [mismatch({ evidence: [B] })])
      const [after] = ledgerEntries(s.root)
      expect(after?.evidence).toEqual([B])
      // The revision follows the evidence it covers; nothing else changes.
      expect(after?.revision).toBe(
        revisionOfCandidate(mismatch({ evidence: [B] })),
      )
      expect(after?.revision).not.toBe(before?.revision)
      expect({ ...after, evidence: undefined, revision: undefined }).toEqual({
        ...before,
        evidence: undefined,
        revision: undefined,
      })
    })

    it('reopens when the evidence the decision was made from changes', () => {
      const { s } = decidedOnB()
      const outcomes = publishedOutcomes(
        s.publish(
          'run-3',
          [mismatch({ evidence: [B] })],
          undefined,
          inventory({ [A_KEY]: present('A1'), [B_KEY]: present('B2') }),
        ),
      )
      expect(outcomes).toMatchObject([
        {
          standing: 'reopened',
          reason: 'evidence changed',
          priorStatus: 'rejected',
        },
      ])
    })

    it('does not reopen when only the evidence it was replaced by changes', () => {
      const { s } = decidedOnB()
      const outcomes = publishedOutcomes(
        s.publish(
          'run-3',
          [mismatch({ evidence: [B] })],
          undefined,
          inventory({ [A_KEY]: present('A2'), [B_KEY]: present('B1') }),
        ),
      )
      expect(outcomes.map((o) => o.standing)).toEqual(['suppressed'])
    })

    it('leaves a decided entry as it is when a run publishes it again', () => {
      const s = session()
      s.publish('run-1', [mismatch({ evidence: [A] })])
      decide(s, ledgerEntries(s.root)[0]?.id ?? '', 'rejected')
      const before = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
      s.publish('run-2', [mismatch({ evidence: [B] })])
      expect(ledgerEntries(s.root)[0]?.evidence).toEqual([A])
      expect(fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')).toBe(
        before,
      )
    })
  })

  it('does not reopen a decided entry of another kind when it has no evidence', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    decide(s, ledgerEntries(s.root)[0]?.id ?? '', 'rejected')
    const outcomes = publishedOutcomes(s.publish('run-2', [candidate()]))
    expect(outcomes.map((o) => o.standing)).toEqual(['suppressed'])
  })

  describe('with two recorded evidence files', () => {
    const FIRST = {
      project: EVIDENCE_PROJECT,
      path: 'Caddyfile',
      fingerprint: 'E1',
    }
    const SECOND = {
      project: EVIDENCE_PROJECT,
      path: 'src/second.ts',
      fingerprint: 'E2',
    }
    const FIRST_KEY = `${EVIDENCE_PROJECT}:Caddyfile`
    const SECOND_KEY = `${EVIDENCE_PROJECT}:src/second.ts`

    function twoRefs(): Session {
      const s = session()
      s.publish('run-1', [mismatch({ evidence: [FIRST, SECOND] })])
      expect(ledgerEntries(s.root)[0]?.evidence).toHaveLength(2)
      return s
    }

    it('reopens when only the second one changed', () => {
      const s = twoRefs()
      expect(
        publishedOutcomes(
          s.publish(
            'run-2',
            [mismatch({ evidence: [FIRST, SECOND] })],
            undefined,
            inventory({
              [FIRST_KEY]: present('E1'),
              [SECOND_KEY]: present('E2-changed'),
            }),
          ),
        ),
      ).toMatchObject([{ standing: 'reopened', reason: 'evidence changed' }])
    })

    it('reopens when only the second one is gone', () => {
      const s = twoRefs()
      expect(
        publishedOutcomes(
          s.publish(
            'run-2',
            [mismatch({ evidence: [FIRST, SECOND] })],
            undefined,
            inventory({ [FIRST_KEY]: present('E1'), [SECOND_KEY]: GONE }),
          ),
        ),
      ).toMatchObject([{ standing: 'reopened', reason: 'evidence changed' }])
    })

    it('is suppressed while both are unchanged', () => {
      const s = twoRefs()
      expect(
        publishedOutcomes(
          s.publish(
            'run-2',
            [mismatch({ evidence: [FIRST, SECOND] })],
            undefined,
            inventory({
              [FIRST_KEY]: present('E1'),
              [SECOND_KEY]: present('E2'),
            }),
          ),
        ),
      ).toMatchObject([{ standing: 'suppressed' }])
    })
  })

  it('reopens as "sources changed" when the learning changed and an evidence file is gone', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const changed = mismatch({
      sources: [
        {
          role: `source@${LEARNING_PROJECT}`,
          path: LEARNING_PATH,
          fingerprint: 'L2',
        },
      ],
    })
    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [changed],
          undefined,
          inventory({ [EVIDENCE_KEY]: GONE }),
        ),
      ),
    ).toMatchObject([{ standing: 'reopened', reason: 'sources changed' }])
  })

  it('is unresolved when the learning itself is missing, whatever happened to the evidence', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const missing = mismatch({
      sources: [
        {
          role: `source@${LEARNING_PROJECT}`,
          path: LEARNING_PATH,
          fingerprint: undefined,
        },
      ],
    })
    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [missing],
          undefined,
          inventory({ [EVIDENCE_KEY]: GONE }),
        ),
      ),
    ).toMatchObject([{ standing: 'unresolved', missing: [LEARNING_PATH] }])
  })

  it('suppresses an unchanged learning with unchanged evidence, whatever the prior status', () => {
    const s = session()
    const same = inventory({ [EVIDENCE_KEY]: present('E1') })
    s.publish('run-1', [mismatch()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    decide(s, id, 'rejected')
    expect(
      publishedOutcomes(s.publish('run-2', [mismatch()], undefined, same)),
    ).toMatchObject([{ standing: 'suppressed', priorStatus: 'rejected' }])
    decide(s, id, 'promoted', { destination: LEARNING_PATH })
    expect(
      publishedOutcomes(s.publish('run-3', [mismatch()], undefined, same)),
    ).toMatchObject([{ standing: 'suppressed', priorStatus: 'promoted' }])
  })

  it('suppresses a proposal that cites another evidence set when the recorded files are unchanged', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const elsewhere = mismatch({
      evidence: [
        {
          project: EVIDENCE_PROJECT,
          path: 'Caddyfile.other',
          fingerprint: 'Z',
        },
      ],
    })
    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [elsewhere],
          undefined,
          inventory({
            [EVIDENCE_KEY]: present('E1'),
            [`${EVIDENCE_PROJECT}:Caddyfile.other`]: present('Z'),
          }),
        ),
      ),
    ).toMatchObject([{ standing: 'suppressed' }])
  })

  it('does not reopen for evidence in a project the run did not read', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    expect(
      publishedOutcomes(
        s.publish('run-2', [mismatch()], undefined, inventory({})),
      ),
    ).toMatchObject([{ standing: 'suppressed' }])
  })

  it('judges evidence only when the caller says how the files stand now', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    expect(publishedOutcomes(s.publish('run-2', [mismatch()]))).toMatchObject([
      { standing: 'suppressed' },
    ])
  })

  it('keeps the refresh pointer when a promoted entry reopens for the learning or the evidence', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    decide(s, id, 'promoted', { destination: LEARNING_PATH })

    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [mismatch()],
          undefined,
          inventory({ [EVIDENCE_KEY]: present('E2') }),
        ),
      ),
    ).toMatchObject([
      {
        standing: 'reopened',
        reason: 'evidence changed',
        priorStatus: 'promoted',
        refreshPointer: LEARNING_PATH,
      },
    ])

    decide(s, id, 'promoted', { destination: LEARNING_PATH })
    const changed = mismatch({
      sources: [
        {
          role: `source@${LEARNING_PROJECT}`,
          path: LEARNING_PATH,
          fingerprint: 'L2',
        },
      ],
    })
    expect(publishedOutcomes(s.publish('run-3', [changed]))).toMatchObject([
      {
        standing: 'reopened',
        reason: 'sources changed',
        refreshPointer: LEARNING_PATH,
      },
    ])
  })

  it('keeps two claims in one learning, and two reasons on one claim, as separate entries', () => {
    const s = session()
    const outcomes = publishedOutcomes(
      s.publish('run-1', [
        mismatch(),
        mismatch({ claim: 'claim-2' }),
        mismatch({ mismatchReason: 'unscoped' }),
      ]),
    )
    expect(outcomes.map((o) => o.standing)).toEqual(['new', 'new', 'new'])
    expect(new Set(ledgerEntries(s.root).map((e) => e.id)).size).toBe(3)
  })

  it('treats an edited claim as a new candidate and leaves the old entry alone', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    expect(
      publishedOutcomes(
        s.publish('run-2', [mismatch({ claim: 'claim-edited' })]),
      ),
    ).toMatchObject([{ standing: 'new' }])
    expect(ledgerEntries(s.root)).toHaveLength(2)
  })
})

describe('the ledger fields of a code-mismatch entry', () => {
  it('keeps the mismatch reason and the evidence apart from the decision reason', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const id = ledgerEntries(s.root)[0]?.id ?? ''
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      mismatchReason: 'stale',
      evidence: [
        { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E1' },
      ],
    })
    expect(ledgerEntries(s.root)[0]?.reason).toBeUndefined()

    decide(s, id, 'rejected')
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      status: 'rejected',
      reason: 'decided rejected',
      mismatchReason: 'stale',
      evidence: [
        { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E1' },
      ],
    })
  })

  it('moves the old reason and evidence into history on a reopen and writes the new ones', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    s.publish(
      'run-2',
      [
        mismatch({
          evidence: [
            { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E2' },
          ],
        }),
      ],
      undefined,
      inventory({ [EVIDENCE_KEY]: present('E2') }),
    )
    const [entry] = ledgerEntries(s.root)
    expect(entry).toMatchObject({
      reopened: 'target changed',
      reopenedFor: 'evidence changed',
      mismatchReason: 'stale',
      evidence: [{ fingerprint: 'E2' }],
    })
    expect(entry?.history[0]).toMatchObject({
      mismatchReason: 'stale',
      evidence: [{ fingerprint: 'E1' }],
    })
  })

  it('does not write the fields for any other kind', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const text = readFileText(path.join(s.root, 'ledger.json'))
    expect(text).not.toMatch(/mismatchReason|"evidence"/)
  })

  it('reads a ledger written before the fields existed and classifies it as it did', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const before = readLedger(s.root)
    if (before.status !== 'ok') throw new Error('ledger unreadable')
    expect(before.ledger.entries[0]?.mismatchReason).toBeUndefined()
    expect(
      classifyCandidate(
        before.ledger,
        candidate(),
        inventory({ [EVIDENCE_KEY]: GONE }),
      ),
    ).toMatchObject({ standing: 'suppressed' })
  })

  it('refuses a ledger whose mismatch fields are malformed', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const file = path.join(s.root, 'ledger.json')
    const parsed = JSON.parse(readFileText(file)) as {
      entries: Array<Record<string, unknown>>
    }
    for (const entry of parsed.entries) entry.evidence = [{ path: 7 }]
    fs.writeFileSync(file, JSON.stringify(parsed))
    expect(readLedger(s.root)).toEqual({
      status: 'unreadable',
      reason: 'invalid',
    })
  })

  it('refuses to publish a candidate whose mismatch fields are malformed', () => {
    const s = session()
    const result = s.publish('run-1', [
      mismatch({
        evidence: [{ project: 'nope', path: 'a', fingerprint: 'x' }],
      }),
    ])
    expect(result).toEqual({ status: 'failed', reason: 'invalid-candidate' })
  })
})

// ── decide and clear ────────────────────────────────────────────────────────

describe('decideLedgerEntry', () => {
  function seeded(): { s: Session; id: string; options: LockOptions } {
    const s = session()
    s.publish('run-1', [candidate()])
    return {
      s,
      id: ledgerEntries(s.root)[0]?.id ?? '',
      options: {
        pid: 7002,
        processes: fakeProcesses({ 7002: 'd', 7001: 'self' }).table,
      },
    }
  }

  it('records the decision by temp-and-rename under the lock, then releases the lock', () => {
    const { s, id, options } = seeded()
    const result = decideLedgerEntry(
      s.root,
      {
        id,
        status: 'promoted',
        reason: 'recorded in target',
        destination: 'docs/solutions/x.md',
      },
      options,
    )
    expect(result).toMatchObject({
      status: 'decided',
      entry: { id, status: 'promoted', destination: 'docs/solutions/x.md' },
    })
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      status: 'promoted',
      reason: 'recorded in target',
      destination: 'docs/solutions/x.md',
    })
    expect(mode(path.join(s.root, 'ledger.json'))).toBe(0o600)
    expect(fs.readdirSync(s.root).sort()).toEqual(['ledger.json', 'runs'])
  })

  it('fails without writing while another run holds the lock', () => {
    const { s, id, options } = seeded()
    const before = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
    const holder = expectAcquired(
      acquireLock(s.root, { pid: 7001, processes: s.procs.table }),
    )
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'not useful' },
        options,
      ),
    ).toEqual({ status: 'busy', reason: 'held' })
    expect(fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')).toBe(
      before,
    )
    releaseLock(holder)
  })

  it('refuses promoted or rejected without a usable reason', () => {
    const { s, id, options } = seeded()
    const before = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
    for (const status of ['promoted', 'rejected'] as const) {
      for (const reason of ['', '   ', 'bad\u0007reason', 'x'.repeat(2000)]) {
        expect(
          decideLedgerEntry(s.root, { id, status, reason }, options),
        ).toEqual({ status: 'failed', reason: 'invalid-input' })
      }
    }
    expect(fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')).toBe(
      before,
    )
    // A refused decision never took the lock.
    expect(fs.existsSync(path.join(s.root, 'lock'))).toBe(false)
  })

  it('refuses a status other than promoted or rejected', () => {
    const { s, id, options } = seeded()
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'candidate' as 'promoted', reason: 'x' },
        options,
      ),
    ).toEqual({ status: 'failed', reason: 'invalid-input' })
  })

  it('fails for an id the ledger does not hold', () => {
    const { s, options } = seeded()
    expect(
      decideLedgerEntry(
        s.root,
        { id: 'nope', status: 'rejected', reason: 'x' },
        options,
      ),
    ).toEqual({ status: 'failed', reason: 'unknown-candidate' })
    expect(fs.existsSync(path.join(s.root, 'lock'))).toBe(false)
  })

  it('settles a candidate that is still open when asked to settle only an open one', () => {
    const { s, id, options } = seeded()
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'not useful', onlyIfOpen: true },
        options,
      ),
    ).toMatchObject({ status: 'decided', entry: { id, status: 'rejected' } })
    expect(ledgerEntries(s.root)[0]).toMatchObject({ status: 'rejected' })
  })

  it('leaves a settled entry as it is when asked to settle only an open one', () => {
    const { s, id, options } = seeded()
    decideLedgerEntry(
      s.root,
      { id, status: 'promoted', reason: 'by hand', destination: 'x.md' },
      options,
    )
    const before = fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'late tick', onlyIfOpen: true },
        options,
      ),
    ).toEqual({ status: 'failed', reason: 'not-open' })
    expect(fs.readFileSync(path.join(s.root, 'ledger.json'), 'utf8')).toBe(
      before,
    )
    expect(fs.existsSync(path.join(s.root, 'lock'))).toBe(false)
  })

  it('still replaces a settled entry when not asked to settle only an open one', () => {
    const { s, id, options } = seeded()
    decideLedgerEntry(
      s.root,
      { id, status: 'promoted', reason: 'by hand', destination: 'x.md' },
      options,
    )
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'changed my mind' },
        options,
      ),
    ).toMatchObject({ status: 'decided', entry: { status: 'rejected' } })
  })
})

describe('the revision of a ledger entry', () => {
  const changed = candidate({
    sources: [
      { role: 'solution', path: 'docs/solutions/a.md', fingerprint: 'bbb' },
    ],
  })
  const changedAgain = candidate({
    sources: [
      { role: 'solution', path: 'docs/solutions/a.md', fingerprint: 'ccc' },
    ],
  })
  const HEX12 = /^[0-9a-f]{12}$/

  let runNumber = 0

  function options(s: Session): LockOptions {
    return {
      pid: 7002,
      processes: fakeProcesses({ 7002: 'd', 7001: 'self' }).table,
      now: () => s.clock.now,
    }
  }

  function opened(): { s: Session; id: string } {
    const s = session()
    s.publish('run-1', [candidate()])
    return { s, id: ledgerEntries(s.root)[0]?.id ?? '' }
  }

  /** Settle the entry, then reopen it by changing the learning. */
  function reopen(s: Session, id: string, again: CandidateRecord): void {
    decideLedgerEntry(
      s.root,
      { id, status: 'rejected', reason: 'not useful' },
      options(s),
    )
    runNumber += 1
    s.publish(`run-r${runNumber}`, [again])
    s.clock.now += MINUTE
  }

  const revisionIn = (s: Session) => ledgerEntries(s.root)[0]?.revision

  it('stores the revision of what a new entry was proposed with, 12 lowercase hex characters', () => {
    const { s } = opened()
    expect(revisionIn(s)).toMatch(HEX12)
    expect(revisionIn(s)).toBe(revisionOfCandidate(candidate()))
  })

  it('hashes the source, target-evidence and recorded-evidence fingerprints, and nothing else', () => {
    const base = revisionOfCandidate(candidate())
    // Each of the three reviewed inputs changes it.
    expect(
      revisionOfCandidate(
        candidate({
          sources: [
            {
              role: 'solution',
              path: 'docs/solutions/a.md',
              fingerprint: 'zzz',
            },
          ],
        }),
      ),
    ).not.toBe(base)
    expect(
      revisionOfCandidate(
        candidate({
          targetEvidence: [{ path: 'src/x.ts', fingerprint: 't9' }],
        }),
      ),
    ).not.toBe(base)
    expect(
      revisionOfCandidate(
        candidate({
          evidence: [{ project: 'bbbbbbbbbbbb', path: 'f', fingerprint: 'E1' }],
        }),
      ),
    ).not.toBe(base)
    // What is not reviewed does not: the title-side fields, the rule, the order.
    expect(revisionOfCandidate(candidate({ ruleId: 'rule-other' }))).toBe(base)
    expect(
      revisionOfCandidate(
        candidate({
          sources: [
            { role: 'solution', path: 'docs/solutions/b.md', fingerprint: 'q' },
            {
              role: 'solution',
              path: 'docs/solutions/a.md',
              fingerprint: 'aaa',
            },
          ],
        }),
      ),
    ).toBe(
      revisionOfCandidate(
        candidate({
          sources: [
            {
              role: 'solution',
              path: 'docs/solutions/a.md',
              fingerprint: 'aaa',
            },
            { role: 'solution', path: 'docs/solutions/b.md', fingerprint: 'q' },
          ],
        }),
      ),
    )
  })

  it('gives a reopened entry the revision of its new content, and the same content the same revision', () => {
    const { s, id } = opened()
    const first = revisionIn(s)
    reopen(s, id, changed)
    const second = revisionIn(s)
    expect(second).toBe(revisionOfCandidate(changed))
    expect(second).not.toBe(first)
    // Back to the first content: the first revision, not a new number.
    reopen(s, id, candidate())
    expect(revisionIn(s)).toBe(first)
  })

  it('keeps the revision through a decision and when a run publishes the entry unchanged', () => {
    const { s, id } = opened()
    reopen(s, id, changed)
    const revision = revisionIn(s)
    expect(
      publishedOutcomes(s.publish('run-same', [changed])).map(
        (o) => o.standing,
      ),
    ).toEqual(['suppressed'])
    expect(revisionIn(s)).toBe(revision)
    decide(s, id, 'promoted', { destination: 'docs/solutions/x.md' })
    expect(ledgerEntries(s.root)[0]).toMatchObject({
      status: 'promoted',
      revision,
    })
  })

  it('recomputes the revision when an open entry takes the evidence a later run cites, so a decision from the earlier digest is refused', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const [before] = ledgerEntries(s.root)
    if (before === undefined) throw new Error('no entry')
    const earlier = revisionOf(before)
    // The same files, cited differently: the entry takes the new set and stays suppressed.
    const other = mismatch({
      evidence: [
        { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E1' },
        { project: EVIDENCE_PROJECT, path: 'Extra', fingerprint: 'X1' },
      ],
    })
    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [other],
          undefined,
          inventory({ [EVIDENCE_KEY]: present('E1') }),
        ),
      ).map((o) => o.standing),
    ).toEqual(['suppressed'])
    const [after] = ledgerEntries(s.root)
    expect(after?.evidence).toHaveLength(2)
    // What a digest of this evidence would show.
    expect(after?.revision).toBe(revisionOfCandidate(other))
    expect(after?.revision).not.toBe(earlier)
    // A decision from the digest of the earlier evidence is refused, and the entry stays open.
    const id = before.id
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'old digest', revision: earlier },
        options(s),
      ),
    ).toEqual({ status: 'failed', reason: 'stale-revision' })
    expect(ledgerEntries(s.root)[0]).toMatchObject({ status: 'candidate' })
  })

  it('records no evidence, and a new revision, when an open entry is published again as an evidence-free investigation', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const [before] = ledgerEntries(s.root)
    if (before === undefined) throw new Error('no entry')
    expect(before.evidence).toHaveLength(1)
    const id = before.id
    const earlier = revisionOf(before)

    const bare = mismatch({ evidence: [] })
    expect(
      publishedOutcomes(
        s.publish(
          'run-2',
          [bare],
          undefined,
          inventory({ [EVIDENCE_KEY]: present('E1') }),
        ),
      ).map((o) => o.standing),
    ).toEqual(['suppressed'])
    const [after] = ledgerEntries(s.root)
    // The entry no longer watches the files it recorded.
    expect(after).not.toHaveProperty('evidence')
    expect(after?.revision).toBe(revisionOfCandidate(bare))
    expect(after?.revision).not.toBe(earlier)
    // So a decision from the digest of the evidence it had is refused, and the entry stays open.
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'old digest', revision: earlier },
        options(s),
      ),
    ).toEqual({ status: 'failed', reason: 'stale-revision' })
    expect(ledgerEntries(s.root)[0]).toMatchObject({ status: 'candidate' })
  })

  it('recomputes the revision of an entry written before revisions when a run re-cites its evidence', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const file = path.join(s.root, 'ledger.json')
    const ledger = JSON.parse(readFileText(file)) as {
      entries: Array<Record<string, unknown>>
    }
    for (const entry of ledger.entries) delete entry.revision
    fs.writeFileSync(file, JSON.stringify(ledger))
    const [before] = ledgerEntries(s.root)
    if (before === undefined) throw new Error('no entry')
    const other = mismatch({
      evidence: [
        { project: EVIDENCE_PROJECT, path: 'Caddyfile', fingerprint: 'E1' },
        { project: EVIDENCE_PROJECT, path: 'Extra', fingerprint: 'X1' },
      ],
    })
    s.publish(
      'run-2',
      [other],
      undefined,
      inventory({ [EVIDENCE_KEY]: present('E1') }),
    )
    const [after] = ledgerEntries(s.root)
    expect(after?.revision).toBe(revisionOfCandidate(other))
    expect(after?.revision).not.toBe(revisionOf(before))
  })

  it('leaves the revision alone when a run cites the same evidence again', () => {
    const s = session()
    s.publish('run-1', [mismatch()])
    const [before] = ledgerEntries(s.root)
    s.publish(
      'run-2',
      [mismatch()],
      undefined,
      inventory({ [EVIDENCE_KEY]: present('E1') }),
    )
    expect(ledgerEntries(s.root)[0]?.revision).toBe(before?.revision)
  })

  it('reads an entry with no stored revision as the revision of its fields', () => {
    const { s, id } = opened()
    const file = path.join(s.root, 'ledger.json')
    const ledger = JSON.parse(readFileText(file)) as {
      entries: Array<Record<string, unknown>>
    }
    for (const entry of ledger.entries) delete entry.revision
    fs.writeFileSync(file, JSON.stringify(ledger))
    const [entry] = ledgerEntries(s.root)
    if (entry === undefined) throw new Error('no entry')
    expect(revisionOf(entry)).toBe(revisionOfCandidate(candidate()))
    expect(
      decideLedgerEntry(
        s.root,
        {
          id,
          status: 'rejected',
          reason: 'now',
          revision: revisionOfCandidate(candidate()),
        },
        options(s),
      ),
    ).toMatchObject({ status: 'decided' })
  })

  it('applies a decision made against the current revision', () => {
    const { s, id } = opened()
    reopen(s, id, changed)
    expect(
      decideLedgerEntry(
        s.root,
        {
          id,
          status: 'rejected',
          reason: 'now',
          revision: revisionOfCandidate(changed),
        },
        options(s),
      ),
    ).toMatchObject({ status: 'decided', entry: { id, status: 'rejected' } })
  })

  it('refuses a decision made against another revision and writes nothing', () => {
    const { s, id } = opened()
    const first = revisionOfCandidate(candidate())
    reopen(s, id, changed)
    const before = readFileText(path.join(s.root, 'ledger.json'))
    for (const revision of [first, revisionOfCandidate(changedAgain)]) {
      expect(
        decideLedgerEntry(
          s.root,
          { id, status: 'rejected', reason: 'old', revision },
          options(s),
        ),
      ).toEqual({ status: 'failed', reason: 'stale-revision' })
    }
    expect(readFileText(path.join(s.root, 'ledger.json'))).toBe(before)
    expect(ledgerEntries(s.root)[0]).toMatchObject({ status: 'candidate' })
    expect(fs.existsSync(path.join(s.root, 'lock'))).toBe(false)
  })

  it('decides regardless of revision when the caller names none', () => {
    const { s, id } = opened()
    reopen(s, id, changed)
    expect(
      decideLedgerEntry(
        s.root,
        { id, status: 'rejected', reason: 'by hand' },
        options(s),
      ),
    ).toMatchObject({ status: 'decided' })
  })

  it('refuses a revision that is not 12 lowercase hex characters', () => {
    const { s, id } = opened()
    for (const revision of [
      '',
      'abc',
      'ABCDEF123456',
      'abcdef12345g',
      'abcdef1234567',
    ]) {
      expect(
        decideLedgerEntry(
          s.root,
          { id, status: 'rejected', reason: 'x', revision },
          options(s),
        ),
      ).toEqual({ status: 'failed', reason: 'invalid-input' })
    }
  })

  it('refuses a ledger whose revision is not 12 lowercase hex characters', () => {
    const { s } = opened()
    const file = path.join(s.root, 'ledger.json')
    const ledger = JSON.parse(readFileText(file)) as {
      entries: Array<Record<string, unknown>>
    }
    for (const bad of ['', 'ABCDEF123456', 'abc', 7, null]) {
      const [entry] = ledger.entries
      if (entry === undefined) throw new Error('no entry')
      fs.writeFileSync(
        file,
        JSON.stringify({ ...ledger, entries: [{ ...entry, revision: bad }] }),
      )
      expect(readLedger(s.root).status).toBe('unreadable')
    }
  })

  it('writes a ledger the shipped reader still loads, new and after a reopen', () => {
    const { s, id } = opened()
    const file = path.join(s.root, 'ledger.json')
    expect(shippedReaderAccepts(readFileText(file))).toBe(true)
    reopen(s, id, changed)
    reopen(s, id, changedAgain)
    const written = readFileText(file)
    expect(JSON.parse(written).entries[0].revision).toMatch(HEX12)
    expect(shippedReaderAccepts(written)).toBe(true)
  })
})

describe('clearLedger', () => {
  it('removes the ledger under the lock and is busy while the lock is held', () => {
    const s = session()
    s.publish('run-1', [candidate()])
    const holder = expectAcquired(
      acquireLock(s.root, { pid: 7001, processes: s.procs.table }),
    )
    const other = {
      pid: 7002,
      processes: fakeProcesses({ 7001: 'self', 7002: 'x' }).table,
    }
    expect(clearLedger(s.root, other)).toEqual({
      status: 'busy',
      reason: 'held',
    })
    expect(fs.existsSync(path.join(s.root, 'ledger.json'))).toBe(true)
    releaseLock(holder)

    expect(clearLedger(s.root, other)).toEqual({
      status: 'cleared',
      removed: true,
    })
    expect(fs.existsSync(path.join(s.root, 'ledger.json'))).toBe(false)
    expect(clearLedger(s.root, other)).toEqual({
      status: 'cleared',
      removed: false,
    })
  })
})

// ── Prune ───────────────────────────────────────────────────────────────────

describe('pruneRuns', () => {
  function locked(): {
    s: Session
    lock: LockHandle
    now: () => number
  } {
    const s = session()
    const lock = expectAcquired(
      acquireLock(s.root, {
        pid: 7001,
        processes: s.procs.table,
        now: () => s.clock.now,
      }),
    )
    return { s, lock, now: () => s.clock.now }
  }

  it('removes runs older than thirty days and leftover staging directories, and keeps the rest', () => {
    const { s, lock, now } = locked()
    const runs = path.join(s.root, 'runs')
    const mk = (name: string, ageMs: number): void => {
      fs.mkdirSync(path.join(runs, name), { mode: 0o700 })
      fs.writeFileSync(path.join(runs, name, 'digest.md'), 'x')
      ageDirectory(path.join(runs, name), ageMs, s.clock.now)
    }
    mk('old', RUN_RETENTION_MS + DAY)
    mk('recent', 2 * DAY)
    mk('edge', RUN_RETENTION_MS - MINUTE)
    mk('crashed.tmp', 0)
    mk('ancient.tmp', 90 * DAY)
    fs.writeFileSync(
      path.join(s.root, 'ledger.json'),
      '{"version":1,"entries":[]}',
    )

    const result = pruneRuns(s.root, lock, { now })
    expect(result).toMatchObject({ status: 'pruned' })
    if (result.status !== 'pruned') throw new Error('prune failed')
    expect([...result.removedRuns].sort()).toEqual(['old'])
    expect([...result.removedStaging].sort()).toEqual([
      'ancient.tmp',
      'crashed.tmp',
    ])
    expect(fs.readdirSync(runs).sort()).toEqual(['edge', 'recent'])
    expect(fs.existsSync(path.join(s.root, 'ledger.json'))).toBe(true)
    releaseLock(lock)
  })

  it('ignores entries that are not run directories and never follows a symlink', () => {
    const { s, lock, now } = locked()
    const runs = path.join(s.root, 'runs')
    const outside = makeDir('connect-state-outside-')
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    ageDirectory(outside, 90 * DAY, s.clock.now)
    const longAgo = new Date(s.clock.now - 90 * DAY)
    for (const name of ['linked-run', 'linked.tmp']) {
      fs.symlinkSync(outside, path.join(runs, name))
      fs.lutimesSync(path.join(runs, name), longAgo, longAgo)
    }
    fs.writeFileSync(path.join(runs, 'notes.txt'), 'note')
    fs.utimesSync(path.join(runs, 'notes.txt'), longAgo, longAgo)
    fs.mkdirSync(path.join(runs, 'has space'))
    ageDirectory(path.join(runs, 'has space'), 90 * DAY, s.clock.now)

    const result = pruneRuns(s.root, lock, { now })
    expect(result).toMatchObject({
      status: 'pruned',
      removedRuns: [],
      removedStaging: [],
    })
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true)
    expect(fs.readdirSync(runs).sort()).toEqual([
      'has space',
      'linked-run',
      'linked.tmp',
      'notes.txt',
    ])
    releaseLock(lock)
  })

  it('refuses to prune without the lock', () => {
    const { s, lock, now } = locked()
    releaseLock(lock)
    const old = path.join(s.root, 'runs', 'old')
    fs.mkdirSync(old)
    ageDirectory(old, 90 * DAY, s.clock.now)
    expect(pruneRuns(s.root, lock, { now })).toEqual({
      status: 'failed',
      reason: 'lock-lost',
    })
    expect(fs.existsSync(old)).toBe(true)
  })
})

// ── Coverage pruning and rewriting a committed run ──────────────────────────

describe('publishRun coverage', () => {
  const RULE = (n: number): string => `rule-${n.toString(16).padStart(16, '0')}`
  const HASH = 'a'.repeat(64)
  const KEY_A = 'aaaaaaaaaaaa'
  const KEY_B = 'bbbbbbbbbbbb'

  function publishCoverage(
    s: ReturnType<typeof session>,
    runId: string,
    coverage: NonNullable<Parameters<typeof publishRun>[2]['coverage']>,
  ) {
    const lock = expectAcquired(
      acquireLock(s.root, { pid: 7001, processes: s.procs.table }),
    )
    try {
      return publishRun(
        s.root,
        lock,
        { runId, files: { 'digest.md': 'x' }, candidates: [], coverage },
        { now: () => s.clock.now },
      )
    } finally {
      releaseLock(lock)
    }
  }

  function covered(s: ReturnType<typeof session>): string[] {
    const ledger = readLedger(s.root)
    if (ledger.status !== 'ok') throw new Error('ledger unreadable')
    return (ledger.ledger.coverage ?? []).map((record) => record.ruleId).sort()
  }

  function firstRun(s: ReturnType<typeof session>): void {
    publishCoverage(s, 'run-1', {
      runId: 'run-1',
      indexed: [
        { ruleId: RULE(1), hash: HASH, project: KEY_A },
        { ruleId: RULE(2), hash: HASH, project: KEY_B },
      ],
      covered: [RULE(1), RULE(2)],
    })
  }

  it('drops a rule that is gone from a project the run read in full', () => {
    const s = session()
    firstRun(s)
    publishCoverage(s, 'run-2', {
      runId: 'run-2',
      indexed: [{ ruleId: RULE(1), hash: HASH, project: KEY_A }],
      covered: [RULE(1)],
      prunable: [KEY_A, KEY_B],
    })
    expect(covered(s)).toEqual([RULE(1)])
  })

  it('keeps the records of a project the run did not read in full', () => {
    const s = session()
    firstRun(s)
    publishCoverage(s, 'run-2', {
      runId: 'run-2',
      indexed: [{ ruleId: RULE(1), hash: HASH, project: KEY_A }],
      covered: [RULE(1)],
      prunable: [KEY_A],
    })
    expect(covered(s)).toEqual([RULE(1), RULE(2)])
  })

  it('keeps a rule the run asked to retain even in a project read in full', () => {
    const s = session()
    firstRun(s)
    publishCoverage(s, 'run-2', {
      runId: 'run-2',
      indexed: [{ ruleId: RULE(1), hash: HASH, project: KEY_A }],
      covered: [RULE(1)],
      prunable: [KEY_A, KEY_B],
      retain: [RULE(2)],
    })
    expect(covered(s)).toEqual([RULE(1), RULE(2)])
  })

  it('drops a record with no project key only when the run says it may', () => {
    const s = session()
    publishCoverage(s, 'run-1', {
      runId: 'run-1',
      indexed: [{ ruleId: RULE(3), hash: HASH }],
      covered: [RULE(3)],
    })
    publishCoverage(s, 'run-2', {
      runId: 'run-2',
      indexed: [{ ruleId: RULE(1), hash: HASH, project: KEY_A }],
      covered: [RULE(1)],
      prunable: [KEY_A],
      pruneUnattributed: false,
    })
    expect(covered(s)).toEqual([RULE(1), RULE(3)])
    publishCoverage(s, 'run-3', {
      runId: 'run-3',
      indexed: [{ ruleId: RULE(1), hash: HASH, project: KEY_A }],
      covered: [RULE(1)],
      prunable: [KEY_A],
    })
    expect(covered(s)).toEqual([RULE(1)])
  })

  it('refuses a malformed project key or retained rule id', () => {
    const s = session()
    const bad = publishCoverage(s, 'run-1', {
      runId: 'run-1',
      indexed: [{ ruleId: RULE(1), hash: HASH, project: 'not-a-key' }],
      covered: [],
    })
    expect(bad).toEqual({ status: 'failed', reason: 'invalid-coverage' })
    const badRetain = publishCoverage(s, 'run-2', {
      runId: 'run-2',
      indexed: [],
      covered: [],
      retain: ['nope'],
    })
    expect(badRetain).toEqual({ status: 'failed', reason: 'invalid-coverage' })
  })
})

describe('rewriteRunFiles', () => {
  function committed() {
    const s = session()
    s.publish('run-1', [])
    const lock = expectAcquired(
      acquireLock(s.root, { pid: 7001, processes: s.procs.table }),
    )
    return { s, lock }
  }

  it('replaces files of a committed run, owner-only, leaving no temporary file', () => {
    const { s, lock } = committed()
    const result = rewriteRunFiles(s.root, lock, 'run-1', {
      'digest.md': 'new\n',
    })
    releaseLock(lock)
    expect(result).toBe('rewritten')
    const dir = path.join(s.root, 'runs', 'run-1')
    expect(fs.readFileSync(path.join(dir, 'digest.md'), 'utf8')).toBe('new\n')
    expect(fs.statSync(path.join(dir, 'digest.md')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir).sort()).toEqual(['digest.md', 'run.json'])
  })

  it('refuses a file the run does not have, a bad name, a missing run and a lost lock', () => {
    const { s, lock } = committed()
    expect(rewriteRunFiles(s.root, lock, 'run-1', { 'other.md': 'x' })).toBe(
      'failed',
    )
    expect(rewriteRunFiles(s.root, lock, 'run-1', { '../x': 'x' })).toBe(
      'failed',
    )
    expect(rewriteRunFiles(s.root, lock, 'run-9', { 'digest.md': 'x' })).toBe(
      'failed',
    )
    releaseLock(lock)
    expect(rewriteRunFiles(s.root, lock, 'run-1', { 'digest.md': 'x' })).toBe(
      'failed',
    )
  })
})

describe('readCiRunMarker', () => {
  function rootWith(content?: string | Buffer): string {
    const root = newRoot()
    if (content !== undefined) {
      fs.writeFileSync(path.join(root, CI_RUN_FILE), content)
    }
    return root
  }

  const valid = (marker: string): string =>
    JSON.stringify({ version: 1, marker })

  it('names the file the workflow writes', () => {
    expect(CI_RUN_FILE).toBe('ci-run.json')
  })

  it('reads the marker from a well-formed file', () => {
    expect(readCiRunMarker(rootWith(valid('123456789-2')))).toBe('123456789-2')
  })

  it('treats a missing file, a missing root and a root that is not a directory as no CI run, and creates nothing', () => {
    expect(readCiRunMarker(rootWith())).toBeUndefined()
    const missing = path.join(makeDir('connect-state-ci-'), 'nowhere')
    expect(readCiRunMarker(missing)).toBeUndefined()
    expect(fs.existsSync(missing)).toBe(false)
    const file = path.join(makeDir('connect-state-ci-'), 'file')
    fs.writeFileSync(file, valid('1-1'))
    expect(readCiRunMarker(file)).toBeUndefined()
  })

  it.each([
    ['not json', '{ nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no marker', '{"version":1}'],
    ['a numeric marker', '{"version":1,"marker":12}'],
    ['version 2', '{"version":2,"marker":"1-1"}'],
    ['no version', '{"marker":"1-1"}'],
    ['an extra key', '{"version":1,"marker":"1-1","extra":true}'],
    ['an empty marker', '{"version":1,"marker":""}'],
    ['a marker with a space', '{"version":1,"marker":"1 1"}'],
    ['a marker with a slash', '{"version":1,"marker":"../1"}'],
    ['a marker with a newline', '{"version":1,"marker":"1\\n1"}'],
    [
      'a 65-character marker',
      JSON.stringify({ version: 1, marker: 'a'.repeat(65) }),
    ],
    ['an empty file', ''],
  ])('treats %s as no CI run without throwing', (_name, content) => {
    expect(readCiRunMarker(rootWith(content))).toBeUndefined()
  })

  it('accepts a 64-character marker', () => {
    expect(readCiRunMarker(rootWith(valid('a'.repeat(64))))).toBe(
      'a'.repeat(64),
    )
  })

  it('treats a file over the size cap as no CI run', () => {
    const padded = `${valid('1-1')}${' '.repeat(5000)}`
    expect(readCiRunMarker(rootWith(padded))).toBeUndefined()
  })

  it('does not follow a symlink for the file, or a symlink for the root', () => {
    const root = rootWith()
    const real = path.join(makeDir('connect-state-ci-real-'), 'real.json')
    fs.writeFileSync(real, valid('9-9'))
    fs.symlinkSync(real, path.join(root, CI_RUN_FILE))
    expect(readCiRunMarker(root)).toBeUndefined()

    const realRoot = rootWith(valid('8-8'))
    const link = path.join(makeDir('connect-state-ci-link-'), 'state')
    fs.symlinkSync(realRoot, link)
    expect(readCiRunMarker(link)).toBeUndefined()
  })

  it('treats a directory in place of the file as no CI run', () => {
    const root = rootWith()
    fs.mkdirSync(path.join(root, CI_RUN_FILE))
    expect(readCiRunMarker(root)).toBeUndefined()
  })
})

describe('the invocation record', () => {
  const begun: InvocationRecord = {
    version: 1,
    marker: '42-1',
    phase: 'begun',
    runId: 'run-1',
    projects: [
      {
        key: 'a1b2c3d4e5f6',
        name: 'alpha',
        repo: 'o/alpha',
        commit: 'a'.repeat(40),
      },
      { key: '0123456789ab', name: 'beta' },
    ],
  }
  const terminal: InvocationRecord = {
    version: 1,
    marker: '42-1',
    phase: 'terminal',
    outcome: 'degraded',
    finalLine: 'Connect degraded',
    reason: 'unmatched-entry',
    runId: 'run-1',
    projects: begun.phase === 'begun' ? begun.projects : [],
  }

  function leftovers(root: string): string[] {
    return fs.readdirSync(root).filter((name) => name.includes('.tmp-'))
  }

  it('names the file the workflow reads', () => {
    expect(INVOCATION_FILE).toBe('invocation.json')
  })

  it('writes a record owner-only and reads the same record back', () => {
    const root = newRoot()
    expect(writeInvocationRecord(root, begun)).toBe('written')
    const file = path.join(root, INVOCATION_FILE)
    expect(mode(file)).toBe(0o600)
    expect(readInvocationRecord(root)).toEqual(begun)
    expect(leftovers(root)).toEqual([])
    expect(writeInvocationRecord(root, terminal)).toBe('written')
    expect(readInvocationRecord(root)).toEqual(terminal)
  })

  it('keeps the previous record when the write fails', () => {
    const root = newRoot()
    writeInvocationRecord(root, begun)
    const before = fs.readFileSync(path.join(root, INVOCATION_FILE), 'utf8')
    const result = writeInvocationRecord(root, terminal, {
      beforeWrite: () => {
        throw new Error('disk full')
      },
    })
    expect(result).toBe('failed')
    expect(fs.readFileSync(path.join(root, INVOCATION_FILE), 'utf8')).toBe(
      before,
    )
    expect(leftovers(root)).toEqual([])
  })

  it('replaces a symlink at the record path instead of writing through it', () => {
    const root = newRoot()
    const victim = path.join(makeDir('connect-state-victim-'), 'victim.txt')
    fs.writeFileSync(victim, 'keep\n')
    fs.symlinkSync(victim, path.join(root, INVOCATION_FILE))
    expect(writeInvocationRecord(root, begun)).toBe('written')
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep\n')
    expect(readInvocationRecord(root)).toEqual(begun)
  })

  it('writes named fields only', () => {
    const root = newRoot()
    const sneaky = {
      ...begun,
      token: 'ghp_x',
      projects: [{ ...(begun.projects[0] ?? {}), root: '/secret' }],
    }
    expect(
      writeInvocationRecord(root, sneaky as unknown as InvocationRecord),
    ).toBe('written')
    const text = fs.readFileSync(path.join(root, INVOCATION_FILE), 'utf8')
    expect(text).not.toContain('ghp_x')
    expect(text).not.toContain('/secret')
  })

  it.each([
    ['a bad marker', { ...begun, marker: 'a b' }],
    ['a bad version', { ...begun, version: 2 }],
    ['a bad phase', { ...begun, phase: 'middle' }],
    ['a bad run id', { ...begun, runId: '../x' }],
    ['a bad project key', { ...begun, projects: [{ key: 'xyz', name: 'a' }] }],
    [
      'a bad repo',
      {
        ...begun,
        projects: [{ key: 'a1b2c3d4e5f6', name: 'a', repo: 'no-slash' }],
      },
    ],
    [
      'a bad commit',
      {
        ...begun,
        projects: [{ key: 'a1b2c3d4e5f6', name: 'a', commit: 'zz' }],
      },
    ],
    ['a terminal record with a bad outcome', { ...terminal, outcome: 'great' }],
    [
      'a terminal record with a control character in the reason',
      { ...terminal, reason: 'bad\nreason' },
    ],
  ])('refuses %s and writes nothing', (_name, record) => {
    const root = newRoot()
    expect(
      writeInvocationRecord(root, record as unknown as InvocationRecord),
    ).toBe('failed')
    expect(fs.existsSync(path.join(root, INVOCATION_FILE))).toBe(false)
    expect(leftovers(root)).toEqual([])
  })

  it('fails without throwing when the root cannot be written', () => {
    const missing = path.join(makeDir('connect-state-inv-'), 'nowhere')
    expect(writeInvocationRecord(missing, begun)).toBe('failed')
  })

  it.each([
    ['not json', '{ nope'],
    ['an array', '[]'],
    ['an unknown phase', '{"version":1,"marker":"1-1","phase":"x"}'],
    [
      'a begun record without a run id',
      '{"version":1,"marker":"1-1","phase":"begun","projects":[]}',
    ],
  ])('reads %s as no record', (_name, content) => {
    const root = newRoot()
    fs.writeFileSync(path.join(root, INVOCATION_FILE), content)
    expect(readInvocationRecord(root)).toBeUndefined()
  })

  it('reads a missing file, and a file over the cap, as no record', () => {
    const root = newRoot()
    expect(readInvocationRecord(root)).toBeUndefined()
    fs.writeFileSync(
      path.join(root, INVOCATION_FILE),
      `${JSON.stringify(begun)}${' '.repeat(2 * 1024 * 1024)}`,
    )
    expect(readInvocationRecord(root)).toBeUndefined()
  })
})
