import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readBytesBounded } from '../../src/lib/search-bounded-read.js'
import { cleanupTempDirs, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

function fixture(): string {
  return fs.realpathSync(makeDir('bounded-read-'))
}

describe('readBytesBounded', () => {
  test('returns the bytes of a file within the cap, including one of exactly the cap', () => {
    const dir = fixture()
    fs.writeFileSync(path.join(dir, 'small.txt'), 'hello')
    fs.writeFileSync(path.join(dir, 'exact.txt'), 'x'.repeat(100))

    const small = readBytesBounded(path.join(dir, 'small.txt'), 100)
    const exact = readBytesBounded(path.join(dir, 'exact.txt'), 100)

    expect(small.kind === 'bytes' && small.bytes.toString()).toBe('hello')
    expect(exact.kind === 'bytes' && exact.bytes.byteLength).toBe(100)
  })

  test('a file one byte over the cap is too large and reports the cap plus one bytes read', () => {
    const dir = fixture()
    fs.writeFileSync(path.join(dir, 'over.txt'), 'x'.repeat(101))

    expect(readBytesBounded(path.join(dir, 'over.txt'), 100)).toEqual({
      kind: 'too-large',
      bytesRead: 101,
    })
  })

  test('a file far over the cap is read no further than the cap plus one byte', () => {
    const dir = fixture()
    fs.writeFileSync(path.join(dir, 'huge.txt'), 'x'.repeat(500 * 1024))
    const realReadSync = fs.readSync.bind(fs)
    let bytesRead = 0
    const spy = spyOn(fs, 'readSync').mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const count = realReadSync(...args)
      bytesRead += count
      return count
    }) as typeof fs.readSync)
    try {
      expect(readBytesBounded(path.join(dir, 'huge.txt'), 1000).kind).toBe(
        'too-large',
      )
    } finally {
      spy.mockRestore()
    }

    expect(bytesRead).toBe(1001)
  })

  test('a file that grows past the cap while it is being read is rejected the same way', () => {
    const dir = fixture()
    const file = path.join(dir, 'grows.txt')
    fs.writeFileSync(file, 'x'.repeat(100 * 1024))
    const realReadSync = fs.readSync.bind(fs)
    let calls = 0
    const spy = spyOn(fs, 'readSync').mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const count = realReadSync(...args)
      calls += 1
      if (calls === 1) fs.appendFileSync(file, 'x'.repeat(100 * 1024))
      return count
    }) as typeof fs.readSync)
    let read: ReturnType<typeof readBytesBounded>
    try {
      read = readBytesBounded(file, 120 * 1024)
    } finally {
      spy.mockRestore()
    }

    expect(read.kind).toBe('too-large')
    expect(calls).toBeGreaterThan(1)
  })

  test('a missing path is absent, a directory is not a regular file', () => {
    const dir = fixture()

    expect(readBytesBounded(path.join(dir, 'nope'), 100)).toEqual({
      kind: 'absent',
    })
    expect(readBytesBounded(dir, 100)).toEqual({ kind: 'not-regular' })
  })

  // A blocked synchronous read cannot be interrupted by a test timeout, so the
  // read runs in a child process that is killed after a deadline.
  test('a FIFO is not a regular file and does not block the reader', () => {
    const dir = fixture()
    const fifo = path.join(dir, 'pipe')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    const script = `import { readBytesBounded } from ${JSON.stringify(
      path.resolve(import.meta.dirname, '../../src/lib/search-bounded-read.ts'),
    )}
console.log(JSON.stringify(readBytesBounded(process.env.TARGET ?? '', 100)))`

    const child = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, TARGET: fifo },
      encoding: 'utf8',
      timeout: 10_000,
    })

    expect(child.signal).toBeNull()
    expect(JSON.parse(child.stdout)).toEqual({ kind: 'not-regular' })
  }, 20_000)
})
