import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createOpencodeOperationObserver,
  type OperationObserverCommandResult,
  type OperationObserverRemoteCommandResult,
} from '../../src/lib/opencode-operation-observer.js'

interface GitFixture {
  root: string
  cleanup(): void
}

function runGit(
  root: string,
  args: readonly string[],
): OperationObserverCommandResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    status: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function createGitFixture(): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-observer-'))
  const git = (args: readonly string[]) => {
    const result = runGit(root, args)
    if (result.status !== 0) throw new Error(`git setup failed: ${args[0]}`)
  }
  git(['init', '--quiet'])
  git(['config', 'user.email', 'observer@example.invalid'])
  git(['config', 'user.name', 'Observer Test'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n')
  git(['add', 'tracked.txt'])
  git(['commit', '--quiet', '-m', 'initial'])
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

describe('OpenCode operation observer', () => {
  test('keeps target stable while repository and worktree revisions change', async () => {
    const fixture = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
      })
      const initial = await observer.snapshot()
      expect(initial.status).toBe('available')
      if (initial.status !== 'available') return

      const unchanged = await observer.snapshot()
      expect(unchanged).toEqual(initial)

      fs.writeFileSync(path.join(fixture.root, 'tracked.txt'), 'edited\n')
      const edited = await observer.snapshot()
      expect(edited.status).toBe('available')
      if (edited.status !== 'available') return
      expect(edited.snapshot.targetDigest).toBe(initial.snapshot.targetDigest)
      expect(edited.snapshot.repositoryRevisionDigest).toBe(
        initial.snapshot.repositoryRevisionDigest,
      )
      expect(edited.snapshot.worktreeRevisionDigest).not.toBe(
        initial.snapshot.worktreeRevisionDigest,
      )

      runGit(fixture.root, ['add', 'tracked.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'edited'])
      const committed = await observer.snapshot()
      expect(committed.status).toBe('available')
      if (committed.status !== 'available') return
      expect(committed.snapshot.targetDigest).toBe(
        initial.snapshot.targetDigest,
      )
      expect(committed.snapshot.repositoryRevisionDigest).not.toBe(
        initial.snapshot.repositoryRevisionDigest,
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('detects staged and untracked content changes, including same-path rewrites', async () => {
    const fixture = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
      })
      const initial = await observer.snapshot()
      expect(initial.status).toBe('available')
      if (initial.status !== 'available') return

      fs.writeFileSync(path.join(fixture.root, 'tracked.txt'), 'staged\n')
      const unstaged = await observer.snapshot()
      expect(unstaged.status).toBe('available')
      if (unstaged.status !== 'available') return
      expect(unstaged.snapshot.worktreeRevisionDigest).not.toBe(
        initial.snapshot.worktreeRevisionDigest,
      )

      runGit(fixture.root, ['add', 'tracked.txt'])
      const staged = await observer.snapshot()
      expect(staged.status).toBe('available')
      if (staged.status !== 'available') return
      expect(staged.snapshot.worktreeRevisionDigest).not.toBe(
        unstaged.snapshot.worktreeRevisionDigest,
      )

      const untrackedPath = path.join(fixture.root, 'untracked.txt')
      fs.writeFileSync(untrackedPath, 'one\n')
      const untracked = await observer.snapshot()
      expect(untracked.status).toBe('available')
      if (untracked.status !== 'available') return
      fs.writeFileSync(untrackedPath, 'two\n')
      const rewritten = await observer.snapshot()
      expect(rewritten.status).toBe('available')
      if (rewritten.status !== 'available') return
      expect(rewritten.snapshot.worktreeRevisionDigest).not.toBe(
        untracked.snapshot.worktreeRevisionDigest,
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('changes target digest for a different local target', async () => {
    const first = createGitFixture()
    const second = createGitFixture()
    try {
      const firstResult = await createOpencodeOperationObserver({
        targetDirectory: first.root,
      }).snapshot()
      const secondResult = await createOpencodeOperationObserver({
        targetDirectory: second.root,
      }).snapshot()
      expect(firstResult.status).toBe('available')
      expect(secondResult.status).toBe('available')
      if (
        firstResult.status !== 'available' ||
        secondResult.status !== 'available'
      ) {
        return
      }
      expect(firstResult.snapshot.targetDigest).not.toBe(
        secondResult.snapshot.targetDigest,
      )
      for (const digest of Object.values(firstResult.snapshot)) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
      }
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  test('fails closed on command failure and bounded output without exposing raw facts', async () => {
    const fixture = createGitFixture()
    const secret = 'raw-observer-secret'
    try {
      const failed = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        commandRunner: () => ({
          status: 1,
          stdout: `${fixture.root}/${secret}`,
          stderr: `${fixture.root}/${secret}`,
        }),
      })
      const failedResult = await failed.snapshot()
      expect(failedResult).toEqual({
        status: 'unavailable',
        reasonCode: 'command-failed',
      })
      expect(JSON.stringify(failedResult)).not.toContain(secret)
      expect(JSON.stringify(failedResult)).not.toContain(fixture.root)

      const bounded = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: { maxCommandOutputBytes: 8 },
        commandRunner: () => ({
          status: 0,
          stdout: 'x'.repeat(32),
          stderr: '',
        }),
      })
      const boundedResult = await bounded.snapshot()
      expect(boundedResult).toEqual({
        status: 'unavailable',
        reasonCode: 'command-output-limit',
      })
      expect(JSON.stringify(boundedResult)).not.toContain(secret)

      const fileLimited = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: { maxFiles: 0 },
      })
      await expect(fileLimited.snapshot()).resolves.toEqual({
        status: 'unavailable',
        reasonCode: 'file-limit',
      })

      const bytesLimited = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: { maxTotalFileBytes: 1 },
      })
      await expect(bytesLimited.snapshot()).resolves.toEqual({
        status: 'unavailable',
        reasonCode: 'file-output-limit',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('does not open a tracked symlink while hashing link-target changes', async () => {
    const fixture = createGitFixture()
    const realRoot = fs.realpathSync(fixture.root)
    const linkPath = path.join(realRoot, 'link.txt')
    const outsideTarget = path.join(
      os.tmpdir(),
      `systematic-observer-link-target-${Date.now()}.txt`,
    )
    const secondOutsideTarget = `${outsideTarget}.second`
    const opened: string[] = []
    try {
      fs.writeFileSync(outsideTarget, 'one\n')
      fs.symlinkSync(outsideTarget, linkPath)
      runGit(fixture.root, ['add', 'link.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'link'])

      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        fileReader: (filePath) => {
          opened.push(filePath)
          if (filePath === linkPath) throw new Error('symlink-opened')
          return fs.readFileSync(filePath)
        },
        symlinkReader: (filePath) => fs.readlinkSync(filePath),
      })
      const initial = await observer.snapshot()
      expect(initial.status).toBe('available')
      expect(opened).not.toContain(linkPath)
      if (initial.status !== 'available') return

      fs.writeFileSync(secondOutsideTarget, 'two\n')
      fs.unlinkSync(linkPath)
      fs.symlinkSync(secondOutsideTarget, linkPath)
      const changed = await observer.snapshot()
      expect(changed.status).toBe('available')
      if (changed.status !== 'available') return
      expect(changed.snapshot.worktreeRevisionDigest).not.toBe(
        initial.snapshot.worktreeRevisionDigest,
      )
    } finally {
      fs.rmSync(outsideTarget, { force: true })
      fs.rmSync(secondOutsideTarget, { force: true })
      fixture.cleanup()
    }
  })

  test('returns bounded remote readbacks with digest-only retained identities', async () => {
    const fixture = createGitFixture()
    const remoteCommandRunner = (
      executable: 'git' | 'gh',
      args: readonly string[],
      _cwd: string,
      _maxOutputBytes: number,
    ): OperationObserverRemoteCommandResult => {
      if (executable === 'git') {
        return {
          status: 0,
          stdout:
            args[0] === 'rev-parse' && args[1] === 'HEAD'
              ? 'a'.repeat(40)
              : 'origin/main\n',
          stderr: '',
        }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 42,
            state: 'OPEN',
            headRefOid: 'b'.repeat(40),
          }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ state: 'SUCCESS' }]),
        stderr: '',
      }
    }
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        remoteCommandRunner,
      })
      const result = await observer.remoteSnapshot('check-readback', 'after')
      expect(result.status).toBe('available')
      if (result.status !== 'available') return
      expect(result.snapshot.resourceIdentity).toMatch(/^[0-9a-f]{64}$/)
      expect(result.snapshot.resourceRevisionIdentity).toMatch(/^[0-9a-f]{64}$/)
      expect(result.snapshot.pullRequest).toEqual({
        identity: expect.stringMatching(/^[0-9a-f]{64}$/),
        state: 'open',
      })
      expect(result.snapshot.checkState).toBe('completed-success')
      expect(JSON.stringify(result)).not.toContain('"number"')
      expect(JSON.stringify(result)).not.toContain('OPEN')
      expect(JSON.stringify(result)).not.toContain('b'.repeat(40))
    } finally {
      fixture.cleanup()
    }
  })

  test('fails closed on bounded or malformed remote readbacks', async () => {
    const fixture = createGitFixture()
    try {
      const oversized = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        remoteCommandRunner: () => ({
          status: 0,
          stdout: 'x'.repeat(8192),
          stderr: '',
        }),
        limits: { maxCommandOutputBytes: 4096 },
      })
      await expect(
        oversized.remoteSnapshot('review-readback', 'after'),
      ).resolves.toEqual({
        status: 'unavailable',
        reasonCode: 'remote-command-output-limit',
      })

      const malformed = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        remoteCommandRunner: (
          _executable: 'git' | 'gh',
          _args: readonly string[],
          _cwd: string,
          _maxOutputBytes: number,
        ) => ({ status: 0, stdout: '{bad', stderr: '' }),
      })
      const malformedResult = await malformed.remoteSnapshot(
        'pr-creation',
        'after',
      )
      expect(malformedResult).toEqual({
        status: 'unavailable',
        reasonCode: 'remote-invalid-json',
      })
      expect(JSON.stringify(malformedResult)).not.toContain('bad')
    } finally {
      fixture.cleanup()
    }
  })
})
