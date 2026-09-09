import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HELPER_PATH = path.resolve(
  import.meta.dirname,
  '../../skills/ce-review/scripts/ensure-ignore.mjs',
)
const HELPER_URL = `file://${HELPER_PATH}`

const REQUIRED_ENTRY = '/systematic/ce-review/'

// Resolves a real Node binary via the runtime's own `-p process.execPath`,
// using the original (unmodified) environment, before any test below
// mutates PATH for a fixture. `process.execPath` under `bun test` points at
// the Bun binary, not Node, so this must not be used directly.
const nodeProbe = spawnSync('node', ['-p', 'process.execPath'], {
  encoding: 'utf8',
})
if (nodeProbe.status !== 0 || !nodeProbe.stdout.trim()) {
  throw new Error(
    'fixture setup failed: `node -p process.execPath` did not resolve a Node binary',
  )
}
const NODE_BIN = nodeProbe.stdout.trim()

const createdDirs: string[] = []

function makeDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { force: true, recursive: true })
  }
})

function initRepo(dir: string): void {
  const result = spawnSync('git', ['init', '-q'], { cwd: dir })
  if (result.status !== 0) {
    throw new Error(
      `fixture git init failed: ${result.stderr?.toString() ?? ''}`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) {
    throw new Error('helper stdout was not a JSON object')
  }
  return value
}

interface HelperRun {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

function runHelper(
  root: string,
  extraArgs: readonly string[] = [],
  envOverride?: Record<string, string>,
): HelperRun {
  const result = spawnSync(
    NODE_BIN,
    [HELPER_PATH, '--root', root, ...extraArgs],
    {
      encoding: 'utf8',
      env: envOverride ? { ...process.env, ...envOverride } : process.env,
    },
  )
  return {
    exitCode: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function readIgnoreFile(root: string): string {
  return fs.readFileSync(path.join(root, '.context', '.gitignore'), 'utf8')
}

/**
 * Runs `scriptSource` as a standalone Node ESM module (`--input-type=module`)
 * so internal functions can be exercised with `node:assert` without a static
 * TypeScript import of the untyped `.mjs` helper (which would need
 * declarations or an unsafe cast). `scriptSource` imports the helper via
 * `HELPER_URL` and must exit 0 on success, non-zero on assertion failure.
 */
function runNodeHarness(
  scriptSource: string,
  envOverride?: Record<string, string>,
): HelperRun {
  const result = spawnSync(NODE_BIN, ['--input-type=module'], {
    encoding: 'utf8',
    env: envOverride ? { ...process.env, ...envOverride } : process.env,
    input: scriptSource,
  })
  return {
    exitCode: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

// ── CLI behavior: happy paths ────────────────────────────────────────────────

describe('ensure-ignore CLI: preparation and protection', () => {
  it('prepares and protects a fresh repository with missing .context', () => {
    const root = makeDir('ensure-ignore-fresh-')
    initRepo(root)

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    const parsed = parseJsonRecord(stdout)
    expect(parsed.status).toBe('protected')
    expect(readIgnoreFile(root)).toBe(`${REQUIRED_ENTRY}\n`)
  })

  it('adds the explicit nested entry even when the root already ignores .context', () => {
    const root = makeDir('ensure-ignore-parent-ignored-')
    initRepo(root)
    fs.writeFileSync(path.join(root, '.gitignore'), '.context/\n')

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('protected')
    expect(readIgnoreFile(root)).toBe(`${REQUIRED_ENTRY}\n`)
    // Unrelated root-level ignore data is preserved untouched.
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(
      '.context/\n',
    )
  })

  it('permits persistence for a confirmed non-Git directory', () => {
    const root = makeDir('ensure-ignore-nongit-')

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('not-applicable')
    expect(readIgnoreFile(root)).toBe(`${REQUIRED_ENTRY}\n`)
  })

  it('discloses the tracked/force-add caveat on success', () => {
    const root = makeDir('ensure-ignore-caveat-')
    initRepo(root)

    const { stdout } = runHelper(root)

    const parsed = parseJsonRecord(stdout)
    expect(parsed.caveats).toContain('tracked-files-and-force-add-unaffected')
  })

  it('rejects a missing/invalid root', () => {
    const { exitCode, stdout } = runHelper('/nonexistent/definitely/not/here')

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'invalid-root',
      status: 'blocked',
    })
  })
})

// ── Byte preservation and idempotency ───────────────────────────────────────

describe('ensure-ignore CLI: byte preservation and idempotency', () => {
  it('adds a separator when existing bytes lack a final newline', () => {
    const root = makeDir('ensure-ignore-no-newline-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    fs.writeFileSync(path.join(root, '.context', '.gitignore'), 'existing-line')

    const { exitCode } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(readIgnoreFile(root)).toBe(`existing-line\n${REQUIRED_ENTRY}\n`)
  })

  it('does not add an extra blank line when existing bytes already end with a newline', () => {
    const root = makeDir('ensure-ignore-with-newline-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    fs.writeFileSync(
      path.join(root, '.context', '.gitignore'),
      'existing-line\n',
    )

    const { exitCode } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(readIgnoreFile(root)).toBe(`existing-line\n${REQUIRED_ENTRY}\n`)
  })

  it('preserves file mode across the write', () => {
    const root = makeDir('ensure-ignore-mode-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    fs.writeFileSync(ignorePath, 'existing-line\n', { mode: 0o640 })

    const { exitCode } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(fs.statSync(ignorePath).mode & 0o777).toBe(0o640)
  })

  it('is idempotent on a second invocation and leaves bytes unchanged', () => {
    const root = makeDir('ensure-ignore-idempotent-')
    initRepo(root)

    const first = runHelper(root)
    expect(first.exitCode).toBe(0)
    const afterFirst = readIgnoreFile(root)

    const second = runHelper(root)

    expect(second.exitCode).toBe(0)
    expect(parseJsonRecord(second.stdout).status).toBe('protected')
    expect(readIgnoreFile(root)).toBe(afterFirst)
  })

  it('is textually idempotent for a confirmed non-Git directory', () => {
    const root = makeDir('ensure-ignore-nongit-idempotent-')
    runHelper(root)
    const afterFirst = readIgnoreFile(root)

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('not-applicable')
    expect(readIgnoreFile(root)).toBe(afterFirst)
  })
})

// ── Negation handling ────────────────────────────────────────────────────────

describe('ensure-ignore CLI: negation handling', () => {
  it('re-asserts the entry after a same-file negation defeats it', () => {
    const root = makeDir('ensure-ignore-negation-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    fs.writeFileSync(
      path.join(root, '.context', '.gitignore'),
      `${REQUIRED_ENTRY}\n!${REQUIRED_ENTRY}\n`,
    )

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('protected')
    expect(readIgnoreFile(root)).toBe(
      `${REQUIRED_ENTRY}\n!${REQUIRED_ENTRY}\n${REQUIRED_ENTRY}\n`,
    )
  })

  it('succeeds without editing a deeper .gitignore whose negation cannot re-include an excluded directory', () => {
    const root = makeDir('ensure-ignore-deeper-conflict-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context', 'systematic', 'ce-review'), {
      recursive: true,
    })
    const deeperIgnore = path.join(
      root,
      '.context',
      'systematic',
      'ce-review',
      '.gitignore',
    )
    fs.writeFileSync(deeperIgnore, '!keep-me\n')

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('protected')
    expect(readIgnoreFile(root)).toBe(`${REQUIRED_ENTRY}\n`)
    // The deeper file is not this helper's concern and must be untouched.
    expect(fs.readFileSync(deeperIgnore, 'utf8')).toBe('!keep-me\n')
  })
})

// ── Git classification: ambiguous and error paths ───────────────────────────

describe('ensure-ignore CLI: Git classification', () => {
  it('blocks with a fixed category when Git is missing (ENOENT), never treating it as non-Git', () => {
    const root = makeDir('ensure-ignore-missing-git-')
    const emptyBin = makeDir('ensure-ignore-empty-bin-')

    const { exitCode, stdout } = runHelper(root, [], { PATH: emptyBin })

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'missing-git',
      status: 'blocked',
    })
  })

  it('blocks a bare repository as ambiguous (stdout "false"), not as non-Git', () => {
    const bareRoot = makeDir('ensure-ignore-bare-')
    const result = spawnSync('git', ['init', '-q', '--bare', bareRoot])
    if (result.status !== 0) throw new Error('fixture bare init failed')

    const { exitCode, stdout } = runHelper(bareRoot)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'git-ambiguous',
      status: 'blocked',
    })
  })

  it('blocks on corrupt Git metadata rather than treating it as non-Git', () => {
    const root = makeDir('ensure-ignore-corrupt-')
    fs.writeFileSync(
      path.join(root, '.git'),
      'gitdir: /nonexistent/path/here\n',
    )

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'git-error',
      status: 'blocked',
    })
  })

  it('protects a directory nested inside an existing work tree', () => {
    const repoRoot = makeDir('ensure-ignore-nested-repo-')
    initRepo(repoRoot)
    const nested = path.join(repoRoot, 'sub', 'project')
    fs.mkdirSync(nested, { recursive: true })

    const { exitCode, stdout } = runHelper(nested)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('protected')
    expect(readIgnoreFile(nested)).toBe(`${REQUIRED_ENTRY}\n`)
  })

  it('protects a linked worktree whose .git is a file, not a directory', () => {
    const repoRoot = makeDir('ensure-ignore-worktree-main-')
    initRepo(repoRoot)
    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'x\n')
    const add = spawnSync('git', ['add', '.'], { cwd: repoRoot })
    if (add.status !== 0) throw new Error('fixture add failed')
    const commit = spawnSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-m',
        'init',
      ],
      { cwd: repoRoot },
    )
    if (commit.status !== 0) {
      throw new Error(
        `fixture commit failed: ${commit.stderr?.toString() ?? ''}`,
      )
    }
    const worktreeDir = makeDir('ensure-ignore-worktree-linked-')
    fs.rmdirSync(worktreeDir)
    const worktreeAdd = spawnSync(
      'git',
      ['worktree', 'add', '-q', worktreeDir],
      { cwd: repoRoot },
    )
    if (worktreeAdd.status !== 0) {
      throw new Error(
        `fixture worktree add failed: ${worktreeAdd.stderr?.toString() ?? ''}`,
      )
    }
    expect(fs.lstatSync(path.join(worktreeDir, '.git')).isFile()).toBe(true)

    const { exitCode, stdout } = runHelper(worktreeDir)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('protected')
    expect(readIgnoreFile(worktreeDir)).toBe(`${REQUIRED_ENTRY}\n`)
  })
})

// ── Symlink rejection ────────────────────────────────────────────────────────

describe('ensure-ignore CLI: symlink rejection', () => {
  it('rejects a symlinked .context directory', () => {
    const root = makeDir('ensure-ignore-symlink-context-')
    initRepo(root)
    const elsewhere = makeDir('ensure-ignore-elsewhere-')
    fs.symlinkSync(elsewhere, path.join(root, '.context'), 'dir')

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'symlink-rejected',
      status: 'blocked',
    })
  })

  it('rejects a symlinked .context/.gitignore file', () => {
    const root = makeDir('ensure-ignore-symlink-file-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const target = path.join(root, 'elsewhere-ignore')
    fs.writeFileSync(target, 'x\n')
    fs.symlinkSync(target, path.join(root, '.context', '.gitignore'))

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'symlink-rejected',
      status: 'blocked',
    })
  })
})

// ── CLI argument validation ──────────────────────────────────────────────────

describe('ensure-ignore CLI: argument validation', () => {
  it('rejects a duplicate --root flag rather than silently using the last value', () => {
    const rootA = makeDir('ensure-ignore-dup-a-')
    const rootB = makeDir('ensure-ignore-dup-b-')
    initRepo(rootA)
    initRepo(rootB)

    const result = spawnSync(
      NODE_BIN,
      [HELPER_PATH, '--root', rootA, '--root', rootB],
      { encoding: 'utf8' },
    )

    expect(result.status).toBe(2)
    expect(parseJsonRecord(result.stdout ?? '')).toEqual({
      reason: 'invalid-arguments',
      status: 'blocked',
    })
  })

  it('rejects an unknown flag rather than silently ignoring it', () => {
    const root = makeDir('ensure-ignore-unknown-flag-')
    initRepo(root)

    const { exitCode, stdout } = runHelper(root, ['--bogus', 'value'])

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'invalid-arguments',
      status: 'blocked',
    })
  })

  it('rejects a missing --root value rather than defaulting to the working directory', () => {
    const result = spawnSync(NODE_BIN, [HELPER_PATH, '--root'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(2)
    expect(parseJsonRecord(result.stdout ?? '')).toEqual({
      reason: 'invalid-arguments',
      status: 'blocked',
    })
  })
})

// ── Byte-exactness regression (R2: preserve existing bytes) ────────────────

describe('ensure-ignore CLI: non-UTF-8 byte preservation', () => {
  it('preserves invalid-UTF-8 bytes exactly when appending the required entry', () => {
    const root = makeDir('ensure-ignore-nonutf8-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    // 0xff/0xfe are not valid UTF-8 continuation/lead bytes anywhere in this
    // position; decoding then re-encoding as UTF-8 would replace them with
    // U+FFFD (EF BF BD), which is a different byte sequence than the
    // original. The fix must never decode/re-encode existing bytes.
    const original = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x41, 0x42]),
      Buffer.from('\nsome-pattern\n', 'utf8'),
    ])
    fs.writeFileSync(ignorePath, original)

    const { exitCode } = runHelper(root)

    expect(exitCode).toBe(0)
    const resultBytes = fs.readFileSync(ignorePath)
    const expected = Buffer.concat([
      original,
      Buffer.from(`${REQUIRED_ENTRY}\n`, 'utf8'),
    ])
    expect(resultBytes.equals(expected)).toBe(true)
  })
})

// ── No evidence leakage ──────────────────────────────────────────────────────

describe('ensure-ignore CLI: no evidence leakage', () => {
  it('never echoes raw Git stderr, absolute paths, or file contents in blocked output', () => {
    const root = makeDir('ensure-ignore-canary-')
    fs.writeFileSync(
      path.join(root, '.git'),
      'gitdir: /nonexistent/path/here\n',
    )

    const { stdout, stderr } = runHelper(root)

    expect(stdout).not.toContain('/nonexistent/path/here')
    expect(stdout).not.toContain(root)
    expect(stdout + stderr).not.toContain('fatal:')
  })
})

// ── Internal functions: exercised through a Node ESM harness ───────────────
// These use `node --input-type=module` + `node:assert` instead of a static
// TypeScript import, since the helper is untyped `.mjs` with no
// declarations and this file must not use `any` or an unsafe `as` cast.

describe('ensure-ignore internals: write-conflict detection', () => {
  it('detects a conflicting edit landed between snapshot and write, and does not overwrite it', () => {
    const root = makeDir('ensure-ignore-unit-conflict-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'original\n')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile, writeIgnoreFileIfUnchanged } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const snapshot = readTrustedFile(filePath)
      fs.writeFileSync(filePath, 'concurrently-edited\\n')

      const result = writeIgnoreFileIfUnchanged(filePath, snapshot, 'original\\nappended\\n')
      assert.deepEqual(result, { ok: false, reason: 'conflict' })
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'concurrently-edited\\n')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('detects a conflicting creation for a previously-absent file', () => {
    const root = makeDir('ensure-ignore-unit-conflict-create-')
    const filePath = path.join(root, '.gitignore')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile, writeIgnoreFileIfUnchanged } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const snapshot = readTrustedFile(filePath)
      assert.deepEqual(snapshot, { exists: false })
      fs.writeFileSync(filePath, 'raced-in\\n')

      const result = writeIgnoreFileIfUnchanged(filePath, snapshot, 'new\\n')
      assert.deepEqual(result, { ok: false, reason: 'conflict' })
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'raced-in\\n')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('detects a replacement file with identical bytes but a different inode, and does not overwrite it', () => {
    const root = makeDir('ensure-ignore-unit-conflict-inode-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'same-bytes\n')
    const replacement = path.join(root, '.gitignore.replacement')
    fs.writeFileSync(replacement, 'same-bytes\n')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile, writeIgnoreFileIfUnchanged } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const replacement = ${JSON.stringify(replacement)}
      const originalInode = fs.statSync(filePath).ino
      const snapshot = readTrustedFile(filePath)

      // Replace with a different inode containing byte-identical content.
      fs.renameSync(replacement, filePath)
      const afterInode = fs.statSync(filePath).ino
      assert.notEqual(afterInode, originalInode, 'fixture did not actually change inode')

      const result = writeIgnoreFileIfUnchanged(filePath, snapshot, 'same-bytes\\nappended\\n')
      assert.deepEqual(result, { ok: false, reason: 'conflict' })
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'same-bytes\\n')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('detects a mode-only change between snapshot and write, and does not overwrite it', () => {
    const root = makeDir('ensure-ignore-unit-conflict-mode-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'original\n', { mode: 0o644 })

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile, writeIgnoreFileIfUnchanged } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const snapshot = readTrustedFile(filePath)
      fs.chmodSync(filePath, 0o600)

      const result = writeIgnoreFileIfUnchanged(filePath, snapshot, 'original\\nappended\\n')
      assert.deepEqual(result, { ok: false, reason: 'conflict' })
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'original\\n')
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('writes through when the snapshot still matches immediately before rename', () => {
    const root = makeDir('ensure-ignore-unit-nowrite-conflict-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'original\n')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile, writeIgnoreFileIfUnchanged } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const snapshot = readTrustedFile(filePath)
      const result = writeIgnoreFileIfUnchanged(filePath, snapshot, 'original\\nappended\\n')
      assert.deepEqual(result, { ok: true })
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'original\\nappended\\n')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('ensure-ignore internals: readTrustedFile rejects non-regular files before open', () => {
  it('rejects a Unix domain socket at the path instead of throwing on open', () => {
    const root = makeDir('ensure-ignore-unit-socket-')
    const sockPath = path.join(root, 'sock')

    // A pre-open `lstat` must reject this before `open()` is ever called: on
    // this platform, opening a socket for O_RDONLY fails with a
    // non-standard error code that the old open-then-classify logic did not
    // recognize, so it fell through to `throw error` -- an uncaught crash
    // for a case this function must classify, not propagate.
    const script = `
      import assert from 'node:assert/strict'
      import net from 'node:net'
      import { readTrustedFile } from '${HELPER_URL}'

      const sockPath = ${JSON.stringify(sockPath)}
      const server = net.createServer()
      server.listen(sockPath, () => {
        let threw = false
        let result
        try {
          result = readTrustedFile(sockPath)
        } catch {
          threw = true
        }
        server.close(() => {
          assert.equal(threw, false, 'readTrustedFile must not throw for a non-regular file')
          assert.deepEqual(result, { exists: true, symlink: true })
          process.exit(0)
        })
      })
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('ensure-ignore internals: Git timeout classification', () => {
  it('classifies an injected short timeout distinctly from other Git errors', () => {
    const fakeBin = makeDir('ensure-ignore-fake-bin-')
    const fakeGit = path.join(fakeBin, 'git')
    fs.writeFileSync(fakeGit, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    const root = makeDir('ensure-ignore-timeout-root-')

    const script = `
      import assert from 'node:assert/strict'
      import { classifyGitWorkTree } from '${HELPER_URL}'

      const result = classifyGitWorkTree(${JSON.stringify(root)}, { timeoutMs: 200 })
      assert.deepEqual(result, { kind: 'timeout' })
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('classifies a real, fast repository as work-tree under the same injected timeout', () => {
    const root = makeDir('ensure-ignore-timeout-fast-')
    initRepo(root)

    const script = `
      import assert from 'node:assert/strict'
      import { classifyGitWorkTree } from '${HELPER_URL}'

      const result = classifyGitWorkTree(${JSON.stringify(root)}, { timeoutMs: 200 })
      assert.deepEqual(result, { kind: 'work-tree' })
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })
})
