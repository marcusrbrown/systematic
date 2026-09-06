import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createOpencodeOperationObserver,
  type OpencodeOperationObserver,
  type OperationObserverCommandResult,
  type OperationObserverLimits,
  type OperationObserverRemoteCommandResult,
  type OperationObserverRemoteResult,
  type RemoteOperation,
  type RemoteReadbackPhase,
} from '../../src/lib/opencode-operation-observer.js'

/** `remoteSnapshot` is optional on the interface (implementations that never do readbacks may omit it), but every fixture observer here always implements it. */
function callRemoteSnapshot(
  observer: OpencodeOperationObserver,
  operation: RemoteOperation,
  phase: RemoteReadbackPhase,
): Promise<OperationObserverRemoteResult> {
  const { remoteSnapshot } = observer
  if (!remoteSnapshot) {
    throw new Error('Expected observer.remoteSnapshot to be defined')
  }
  return remoteSnapshot.call(observer, operation, phase)
}

interface GitFixture {
  root: string
  cleanup(): void
}

interface SeparatedGitFixture {
  gitDir: string
  worktree: string
  cleanup(): void
}

interface RegisteredWorktreeFixture {
  parent: GitFixture
  linkedWorktree: string
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

function createRegisteredWorktreeFixture(): RegisteredWorktreeFixture {
  const parent = createGitFixture()
  const linkedWorktree = path.join(
    path.dirname(parent.root),
    `${path.basename(parent.root)}-linked`,
  )
  const result = runGit(parent.root, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    'linked',
    linkedWorktree,
  ])
  if (result.status !== 0) {
    parent.cleanup()
    throw new Error('git setup failed: worktree add')
  }
  return {
    parent,
    linkedWorktree,
    cleanup: () => {
      fs.rmSync(linkedWorktree, { recursive: true, force: true })
      parent.cleanup()
    },
  }
}

function createSeparatedGitFixture(): SeparatedGitFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-observer-separated-'),
  )
  const gitDir = path.join(root, 'repo.git')
  const worktree = path.join(root, 'worktree')
  fs.mkdirSync(worktree, { recursive: true })

  const init = runGit(root, ['init', '--bare', gitDir])
  if (init.status !== 0) throw new Error('git setup failed: init')

  const git = (args: readonly string[], cwd = gitDir) => {
    const result = runGit(cwd, args)
    if (result.status !== 0) throw new Error(`git setup failed: ${args[0]}`)
  }

  git(['config', 'core.bare', 'false'])
  git(['config', 'core.worktree', worktree])
  git(['config', 'user.email', 'observer@example.invalid'])
  git(['config', 'user.name', 'Observer Test'])
  fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'initial\n')
  git(['--work-tree', worktree, 'add', 'tracked.txt'])
  git([
    '--work-tree',
    worktree,
    '-c',
    'user.name=Observer Test',
    '-c',
    'user.email=observer@example.invalid',
    'commit',
    '-m',
    'initial',
  ])

  return {
    gitDir,
    worktree,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function createSeparatedGitRemoteFixture(): SeparatedGitFixture {
  const fixture = createSeparatedGitFixture()
  const root = path.dirname(fixture.gitDir)
  const remote = path.join(root, 'remote.git')
  const init = runGit(root, ['init', '--bare', '--quiet', remote])
  if (init.status !== 0) throw new Error('git setup failed: remote init')

  const configure = (args: readonly string[]) => {
    const result = runGit(fixture.gitDir, args)
    if (result.status !== 0) throw new Error(`git setup failed: ${args[0]}`)
  }
  configure(['remote', 'add', 'origin', remote])
  configure(['branch', '-M', 'main'])
  configure([
    '--work-tree',
    fixture.worktree,
    'push',
    '--quiet',
    '--set-upstream',
    'origin',
    'main',
  ])
  return fixture
}

describe('OpenCode operation observer', () => {
  test('validates a registered linked worktree against its parent identity', () => {
    const fixture = createRegisteredWorktreeFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.parent.root,
      })

      expect(
        observer.validateRegisteredWorktree(fixture.linkedWorktree),
      ).toEqual(
        expect.objectContaining({
          status: 'ok',
          targetRoot: fs.realpathSync(fixture.linkedWorktree),
        }),
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('validates the parent main checkout as a registered worktree', () => {
    const fixture = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
      })

      expect(observer.validateRegisteredWorktree(fixture.root)).toEqual(
        expect.objectContaining({
          status: 'ok',
          targetRoot: fs.realpathSync(fixture.root),
          commonDir: fs.realpathSync(path.join(fixture.root, '.git')),
        }),
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('keeps the parent worktree membership snapshot immutable', () => {
    const parent = createGitFixture()
    const observer = createOpencodeOperationObserver({
      targetDirectory: parent.root,
    })
    const linkedWorktree = path.join(
      path.dirname(parent.root),
      `${path.basename(parent.root)}-late-linked`,
    )
    try {
      const added = runGit(parent.root, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        'late-linked',
        linkedWorktree,
      ])
      expect(added.status).toBe(0)
      expect(observer.validateRegisteredWorktree(linkedWorktree)).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fs.rmSync(linkedWorktree, { recursive: true, force: true })
      parent.cleanup()
    }
  })

  test('canonicalizes a symlink root to the registered worktree identity', () => {
    const fixture = createRegisteredWorktreeFixture()
    const linkedAlias = path.join(
      path.dirname(fixture.linkedWorktree),
      `${path.basename(fixture.linkedWorktree)}-alias`,
    )
    try {
      fs.symlinkSync(fixture.linkedWorktree, linkedAlias, 'dir')
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.parent.root,
      })

      expect(observer.validateRegisteredWorktree(linkedAlias)).toEqual(
        expect.objectContaining({
          status: 'ok',
          targetRoot: fs.realpathSync(fixture.linkedWorktree),
        }),
      )
    } finally {
      fs.rmSync(linkedAlias, { force: true })
      fixture.cleanup()
    }
  })

  test('rejects an independent unrelated repository', () => {
    const parent = createGitFixture()
    const unrelated = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: parent.root,
      })

      expect(observer.validateRegisteredWorktree(unrelated.root)).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
    } finally {
      unrelated.cleanup()
      parent.cleanup()
    }
  })

  test('rejects an independent nested repository inside the parent checkout', () => {
    const parent = createGitFixture()
    const nested = path.join(parent.root, 'nested-repo')
    fs.mkdirSync(nested)
    runGit(nested, ['init', '--quiet'])
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: parent.root,
      })

      expect(observer.validateRegisteredWorktree(nested)).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
    } finally {
      parent.cleanup()
    }
  })

  test('rejects a submodule target whose common directory is under git modules', () => {
    const parent = createGitFixture()
    const submodule = createGitFixture()
    try {
      const added = runGit(parent.root, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        submodule.root,
        'submodule',
      ])
      expect(added.status).toBe(0)
      runGit(parent.root, ['commit', '--quiet', '-am', 'add submodule'])
      const observer = createOpencodeOperationObserver({
        targetDirectory: parent.root,
      })

      expect(
        observer.validateRegisteredWorktree(
          path.join(parent.root, 'submodule'),
        ),
      ).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
    } finally {
      submodule.cleanup()
      parent.cleanup()
    }
  })

  test('rejects a fake gitfile that points directly at the parent git directory', () => {
    const parent = createGitFixture()
    const fakeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-observer-fake-'),
    )
    try {
      fs.writeFileSync(
        path.join(fakeRoot, '.git'),
        `gitdir: ${path.join(parent.root, '.git')}\n`,
      )
      const observer = createOpencodeOperationObserver({
        targetDirectory: parent.root,
      })

      expect(observer.validateRegisteredWorktree(fakeRoot)).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true })
      parent.cleanup()
    }
  })

  test('rejects a fake gitfile that points at a registered worktree admin directory', () => {
    const fixture = createRegisteredWorktreeFixture()
    const fakeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-observer-fake-'),
    )
    try {
      const admin = runGit(fixture.linkedWorktree, [
        'rev-parse',
        '--absolute-git-dir',
      ]).stdout.trim()
      fs.writeFileSync(path.join(fakeRoot, '.git'), `gitdir: ${admin}\n`)
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.parent.root,
      })

      expect(observer.validateRegisteredWorktree(fakeRoot)).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true })
      fixture.cleanup()
    }
  })

  test('ignores poisoned ambient GIT variables in observer subprocesses', async () => {
    const parent = createGitFixture()
    const unrelated = createGitFixture()
    const traceFile = path.join(parent.root, 'git-trace.log')
    const poison = {
      GIT_DIR: path.join(parent.root, '.git'),
      GIT_WORK_TREE: parent.root,
      GIT_COMMON_DIR: path.join(parent.root, '.git'),
      GIT_INDEX_FILE: path.join(parent.root, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: path.join(parent.root, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(
        parent.root,
        '.git',
        'objects',
      ),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'foo.bar',
      GIT_CONFIG_VALUE_0: 'baz',
      GIT_TRACE: traceFile,
    } as const
    try {
      fs.writeFileSync(path.join(unrelated.root, 'tracked.txt'), 'unrelated\n')
      runGit(unrelated.root, ['add', 'tracked.txt'])
      runGit(unrelated.root, ['commit', '--quiet', '-m', 'unrelated'])

      const child = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          [
            "import { createOpencodeOperationObserver } from './src/lib/opencode-operation-observer.ts'",
            'const observer = createOpencodeOperationObserver({ targetDirectory: process.env.PARENT_DIRECTORY })',
            'const result = observer.validateRegisteredWorktree(process.env.TARGET_DIRECTORY)',
            'process.stdout.write(JSON.stringify(result))',
          ].join(';'),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...poison,
            PARENT_DIRECTORY: parent.root,
            TARGET_DIRECTORY: unrelated.root,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      expect(child.exitCode).toBe(0)
      const poisoned = JSON.parse(child.stdout.toString()) as unknown
      expect(poisoned).toEqual({
        status: 'error',
        reasonCode: 'target-unavailable',
      })
      expect(fs.existsSync(traceFile)).toBe(false)
    } finally {
      unrelated.cleanup()
      parent.cleanup()
    }
  })

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
      expect(initial.snapshot.commitClosure).toBe(true)
      expect(edited.snapshot.commitClosure).toBe(false)

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

  test('uses repository-root semantics when target is a repository subdirectory', async () => {
    const fixture = createGitFixture()
    try {
      const subdirectory = path.join(fixture.root, 'nested')
      fs.mkdirSync(subdirectory)
      fs.writeFileSync(path.join(subdirectory, 'nested.txt'), 'nested\n')
      runGit(fixture.root, ['add', 'nested/nested.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'nested'])

      const observer = createOpencodeOperationObserver({
        targetDirectory: subdirectory,
      })
      const initial = await observer.snapshot()
      expect(initial.status).toBe('available')
      if (initial.status !== 'available') return
      expect(initial.snapshot.commitClosure).toBe(true)

      fs.writeFileSync(path.join(fixture.root, 'tracked.txt'), 'root edited\n')
      const changed = await observer.snapshot()
      expect(changed.status).toBe('available')
      if (changed.status !== 'available') return
      expect(changed.snapshot.worktreeRevisionDigest).not.toBe(
        initial.snapshot.worktreeRevisionDigest,
      )
      expect(changed.snapshot.commitClosure).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test('stays available when the git directory and worktree are separate', async () => {
    const fixture = createSeparatedGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.gitDir,
      })
      const result = await observer.snapshot()
      expect(result.status).toBe('available')
      if (result.status !== 'available') return
      expect(result.snapshot.commitClosure).toBe(true)
      expect(result.snapshot.targetDigest).toMatch(/^[0-9a-f]{64}$/)

      fs.writeFileSync(path.join(fixture.worktree, 'tracked.txt'), 'edited\n')
      const edited = await observer.snapshot()
      expect(edited.status).toBe('available')
      if (edited.status !== 'available') return
      expect(edited.snapshot.worktreeRevisionDigest).not.toBe(
        result.snapshot.worktreeRevisionDigest,
      )
      expect(edited.snapshot.commitClosure).toBe(false)

      const untrackedPath = path.join(fixture.worktree, 'untracked.txt')
      fs.writeFileSync(untrackedPath, 'untracked\n')
      const untracked = await observer.snapshot()
      expect(untracked.status).toBe('available')
      if (untracked.status !== 'available') return
      expect(untracked.snapshot.worktreeRevisionDigest).not.toBe(
        edited.snapshot.worktreeRevisionDigest,
      )
      expect(untracked.snapshot.commitClosure).toBe(false)

      runGit(fixture.gitDir, [
        '--work-tree',
        fixture.worktree,
        'add',
        'tracked.txt',
        'untracked.txt',
      ])
      runGit(fixture.gitDir, [
        '--work-tree',
        fixture.worktree,
        'commit',
        '--quiet',
        '-m',
        'edited',
      ])
      const committed = await observer.snapshot()
      expect(committed.status).toBe('available')
      if (committed.status !== 'available') return
      expect(committed.snapshot.commitClosure).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  test('stays available for remote readback when the git directory and worktree are separate', async () => {
    const fixture = createSeparatedGitRemoteFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.gitDir,
      })
      const result = await observer.remoteSnapshot?.('push', 'before')
      expect(result?.status).toBe('available')
      if (result?.status !== 'available') return
      expect(result.snapshot.resourceIdentity).toMatch(/^[0-9a-f]{64}$/)
      expect(result.snapshot.resourceRevisionIdentity).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      fixture.cleanup()
    }
  })

  test('reports partial-stage commit closure as open and full closure as closed', async () => {
    const fixture = createGitFixture()
    try {
      fs.writeFileSync(path.join(fixture.root, 'second.txt'), 'initial\n')
      runGit(fixture.root, ['add', 'second.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'second'])
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
      })
      fs.writeFileSync(path.join(fixture.root, 'tracked.txt'), 'changed\n')
      fs.writeFileSync(path.join(fixture.root, 'second.txt'), 'also changed\n')
      runGit(fixture.root, ['add', 'tracked.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'partial'])
      const partial = await observer.snapshot()
      expect(partial.status).toBe('available')
      if (partial.status !== 'available') return
      expect(partial.snapshot.commitClosure).toBe(false)

      runGit(fixture.root, ['add', 'second.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'close'])
      const closed = await observer.snapshot()
      expect(closed.status).toBe('available')
      if (closed.status !== 'available') return
      expect(closed.snapshot.commitClosure).toBe(true)
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
      expect(staged.snapshot.worktreeRevisionDigest).toBe(
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

      runGit(fixture.root, ['add', 'tracked.txt', 'untracked.txt'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'staged-content'])
      const committed = await observer.snapshot()
      expect(committed.status).toBe('available')
      if (committed.status !== 'available') return
      expect(committed.snapshot.worktreeRevisionDigest).not.toBe(
        staged.snapshot.worktreeRevisionDigest,
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('keeps unchanged committed content stable through add and commit', async () => {
    const fixture = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
      })
      const initial = await observer.snapshot()
      expect(initial.status).toBe('available')
      if (initial.status !== 'available') return

      runGit(fixture.root, ['add', 'tracked.txt'])
      const staged = await observer.snapshot()
      expect(staged.status).toBe('available')
      if (staged.status !== 'available') return
      runGit(fixture.root, ['commit', '--quiet', '-m', 'unchanged'])
      const committed = await observer.snapshot()
      expect(committed.status).toBe('available')
      if (committed.status !== 'available') return
      expect(staged.snapshot.worktreeRevisionDigest).toBe(
        initial.snapshot.worktreeRevisionDigest,
      )
      expect(committed.snapshot.worktreeRevisionDigest).toBe(
        initial.snapshot.worktreeRevisionDigest,
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('changes once for deletion, CRLF bytes, and executable-bit changes', async () => {
    const fixture = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
      })
      const initial = await observer.snapshot()
      expect(initial.status).toBe('available')
      if (initial.status !== 'available') return

      fs.unlinkSync(path.join(fixture.root, 'tracked.txt'))
      const deleted = await observer.snapshot()
      expect(deleted.status).toBe('available')
      if (deleted.status !== 'available') return
      expect(deleted.snapshot.worktreeRevisionDigest).not.toBe(
        initial.snapshot.worktreeRevisionDigest,
      )
      runGit(fixture.root, ['add', '-u'])
      runGit(fixture.root, ['commit', '--quiet', '-m', 'delete'])
      const deletedCommitted = await observer.snapshot()
      expect(deletedCommitted.status).toBe('available')
      if (deletedCommitted.status !== 'available') return
      expect(deletedCommitted.snapshot.worktreeRevisionDigest).toBe(
        deleted.snapshot.worktreeRevisionDigest,
      )

      fs.writeFileSync(path.join(fixture.root, 'tracked.txt'), 'line\r\n')
      const crlf = await observer.snapshot()
      expect(crlf.status).toBe('available')
      if (crlf.status !== 'available') return
      expect(crlf.snapshot.worktreeRevisionDigest).not.toBe(
        deletedCommitted.snapshot.worktreeRevisionDigest,
      )

      fs.writeFileSync(path.join(fixture.root, 'tracked.txt'), 'line\n')
      fs.chmodSync(path.join(fixture.root, 'tracked.txt'), 0o755)
      const executable = await observer.snapshot()
      expect(executable.status).toBe('available')
      if (executable.status !== 'available') return
      expect(executable.snapshot.worktreeRevisionDigest).not.toBe(
        crlf.snapshot.worktreeRevisionDigest,
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
        if (typeof digest === 'string') expect(digest).toMatch(/^[0-9a-f]{64}$/)
      }
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  test('keeps identical registered worktrees distinct by target digest', async () => {
    const fixture = createRegisteredWorktreeFixture()
    const secondLinkedWorktree = path.join(
      path.dirname(fixture.linkedWorktree),
      `${path.basename(fixture.linkedWorktree)}-second`,
    )
    try {
      const added = runGit(fixture.parent.root, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        'linked-second',
        secondLinkedWorktree,
      ])
      expect(added.status).toBe(0)

      const first = await createOpencodeOperationObserver({
        targetDirectory: fixture.linkedWorktree,
      }).snapshot()
      const second = await createOpencodeOperationObserver({
        targetDirectory: secondLinkedWorktree,
      }).snapshot()
      expect(first.status).toBe('available')
      expect(second.status).toBe('available')
      if (first.status !== 'available' || second.status !== 'available') {
        return
      }

      expect(
        runGit(fixture.linkedWorktree, ['rev-parse', 'HEAD']).stdout.trim(),
      ).toBe(runGit(secondLinkedWorktree, ['rev-parse', 'HEAD']).stdout.trim())
      expect(
        fs.readFileSync(
          path.join(fixture.linkedWorktree, 'tracked.txt'),
          'utf8',
        ),
      ).toBe(
        fs.readFileSync(path.join(secondLinkedWorktree, 'tracked.txt'), 'utf8'),
      )
      expect(first.snapshot.targetDigest).not.toBe(second.snapshot.targetDigest)
    } finally {
      fs.rmSync(secondLinkedWorktree, { recursive: true, force: true })
      fixture.cleanup()
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

  test('times out slow commands, kills the child, and fails closed without raw facts', async () => {
    const fixture = createGitFixture()
    const secret = `${fixture.root}/raw-timeout-secret`
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: { maxCommandTimeoutMs: 10 } satisfies OperationObserverLimits,
        commandRunner: (
          _args,
          cwd,
          maxOutputBytes,
          timeoutMs,
        ): OperationObserverCommandResult => {
          const child = spawnSync(
            process.execPath,
            [
              '-e',
              `process.stdout.write(${JSON.stringify(`${secret}\n`)})\nsetTimeout(() => {}, 500)`,
            ],
            {
              cwd,
              encoding: 'utf8',
              maxBuffer: maxOutputBytes,
              timeout: timeoutMs,
            },
          )
          const timedOut =
            (child.error as NodeJS.ErrnoException | undefined)?.code ===
            'ETIMEDOUT'
          return {
            status: child.status ?? -1,
            stdout: secret,
            stderr: timedOut ? secret : '',
            timedOut,
          } as OperationObserverCommandResult
        },
      })
      const started = Date.now()
      const result = await observer.snapshot()
      expect(Date.now() - started).toBeLessThan(250)
      expect(result).toEqual({
        status: 'unavailable',
        reasonCode: 'command-timeout',
      })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain('setTimeout')
    } finally {
      fixture.cleanup()
    }
  })

  test('allows fast commands within the configured timeout bound', async () => {
    const fixture = createGitFixture()
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: {
          maxCommandTimeoutMs: 1_000,
        } satisfies OperationObserverLimits,
      })
      await expect(observer.snapshot()).resolves.toMatchObject({
        status: 'available',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('defaults and injects the timeout bound for local and remote runners', async () => {
    const fixture = createGitFixture()
    try {
      const defaultTimeouts: number[] = []
      const defaulted = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        commandRunner: (args, cwd, _maxOutputBytes, timeoutMs) => {
          defaultTimeouts.push(timeoutMs)
          return runGit(cwd, args)
        },
      })
      await expect(defaulted.snapshot()).resolves.toMatchObject({
        status: 'available',
      })
      expect(defaultTimeouts.length).toBeGreaterThan(0)
      expect(new Set(defaultTimeouts)).toEqual(new Set([5_000]))

      const configuredTimeouts: number[] = []
      const configured = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: { maxCommandTimeoutMs: 7 } satisfies OperationObserverLimits,
        commandRunner: (args, cwd, _maxOutputBytes, timeoutMs) => {
          configuredTimeouts.push(timeoutMs)
          return runGit(cwd, args)
        },
      })
      await expect(configured.snapshot()).resolves.toMatchObject({
        status: 'available',
      })
      expect(configuredTimeouts.length).toBeGreaterThan(0)
      expect(new Set(configuredTimeouts)).toEqual(new Set([7]))

      const remoteTimeouts: number[] = []
      const remote = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        limits: {
          maxCommandTimeoutMs: 1_000,
        } satisfies OperationObserverLimits,
        remoteCommandRunner: (
          executable,
          args,
          _cwd,
          _maxOutputBytes,
          timeoutMs,
        ): OperationObserverRemoteCommandResult => {
          remoteTimeouts.push(timeoutMs)
          if (executable === 'git') {
            return {
              status: 0,
              stdout: 'origin/main\n',
              stderr: '',
            }
          }
          return args[1] === 'checks'
            ? {
                status: 0,
                stdout: JSON.stringify([{ state: 'SUCCESS' }]),
                stderr: '',
              }
            : {
                status: 0,
                stdout: JSON.stringify({
                  number: 42,
                  state: 'OPEN',
                  headRefOid: 'b'.repeat(40),
                }),
                stderr: '',
              }
        },
      })
      await expect(
        callRemoteSnapshot(remote, 'pr-creation', 'after'),
      ).resolves.toMatchObject({ status: 'available' })
      expect(remoteTimeouts.length).toBeGreaterThan(0)
      expect(new Set(remoteTimeouts)).toEqual(new Set([1_000]))
    } finally {
      fixture.cleanup()
    }
  })

  test('fails closed on permission reads and checks size before reading content', async () => {
    const fixture = createGitFixture()
    try {
      const permission = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        statReader: () => {
          throw Object.assign(new Error('permission'), { code: 'EACCES' })
        },
      })
      await expect(permission.snapshot()).resolves.toEqual({
        status: 'unavailable',
        reasonCode: 'file-read-failed',
      })

      let opened = false
      const bounded = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        statReader: (filePath) => ({
          isFile: filePath.endsWith('tracked.txt'),
          isSymbolicLink: false,
          isDirectory: false,
          mode: 0o100644,
          size: 99,
        }),
        fileReader: () => {
          opened = true
          return new Uint8Array(99)
        },
        limits: { maxTotalFileBytes: 1 },
      })
      await expect(bounded.snapshot()).resolves.toEqual({
        status: 'unavailable',
        reasonCode: 'file-output-limit',
      })
      expect(opened).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  test('does not open a tracked symlink while hashing link-target changes', async () => {
    const fixture = createGitFixture()
    const realRoot = fs.realpathSync(fixture.root)
    const linkPath = path.join(realRoot, 'link.txt')
    // Use mkdtempSync for a unique, randomly-named temp directory to avoid
    // insecure predictable temp-file creation flagged by CodeQL.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-observer-symlink-'),
    )
    const outsideTarget = path.join(tempDir, 'link-target-one.txt')
    const secondOutsideTarget = path.join(tempDir, 'link-target-two.txt')
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
      fs.rmSync(tempDir, { recursive: true, force: true })
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
      const result = await callRemoteSnapshot(
        observer,
        'check-readback',
        'after',
      )
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
        callRemoteSnapshot(oversized, 'review-readback', 'after'),
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
      const malformedResult = await callRemoteSnapshot(
        malformed,
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

  test('requires an advanced upstream that equals local HEAD for push readback', async () => {
    const fixture = createGitFixture()
    let upstream = 'a'.repeat(40)
    const localHead = 'b'.repeat(40)
    try {
      const observer = createOpencodeOperationObserver({
        targetDirectory: fixture.root,
        remoteCommandRunner: (_executable, args) => {
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
            return { status: 0, stdout: 'origin/main\n', stderr: '' }
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return { status: 0, stdout: `${localHead}\n`, stderr: '' }
          }
          return { status: 0, stdout: `${upstream}\n`, stderr: '' }
        },
      })
      const before = await observer.remoteSnapshot?.('push', 'before')
      expect(before?.status).toBe('available')
      upstream = localHead
      const after = await observer.remoteSnapshot?.('push', 'after')
      expect(after?.status).toBe('available')
      if (before?.status !== 'available' || after?.status !== 'available')
        return
      expect(after.snapshot.resourceRevisionIdentity).not.toBe(
        before.snapshot.resourceRevisionIdentity,
      )

      upstream = 'a'.repeat(40)
      const notAdvanced = await observer.remoteSnapshot?.('push', 'after')
      expect(notAdvanced).toEqual({
        status: 'unavailable',
        reasonCode: 'remote-not-advanced',
      })
    } finally {
      fixture.cleanup()
    }
  })
})
