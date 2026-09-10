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
const IGNORE_FILE_MAX_BYTES = 1024 * 1024
const ENTRY_LINE_LENGTH = Buffer.byteLength(`${REQUIRED_ENTRY}\n`, 'utf8')

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

  it('rejects a second --root flag used as the first --root value, rather than treating it as a literal path', () => {
    const result = spawnSync(NODE_BIN, [HELPER_PATH, '--root', '--root'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(2)
    expect(parseJsonRecord(result.stdout ?? '')).toEqual({
      reason: 'invalid-arguments',
      status: 'blocked',
    })
  })

  it('rejects an unknown option consumed as a --root value, rather than treating it as a literal path', () => {
    const result = spawnSync(NODE_BIN, [HELPER_PATH, '--root', '--unknown'], {
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

describe('ensure-ignore CLI: filesystem error propagation (non-ENOENT)', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it('blocks with a fixed category (not a crash) on EACCES during unsafe-component detection, with no absolute path or stack leaked', () => {
    if (isRoot) {
      // Root bypasses Unix permission bits on most filesystems, so denying
      // read/execute on `.context` would not reproduce EACCES here. This
      // case is honestly skipped rather than faked with a mock.
      return
    }
    const root = makeDir('ensure-ignore-eacces-context-')
    initRepo(root)
    const contextDir = path.join(root, '.context')
    fs.mkdirSync(contextDir)
    fs.writeFileSync(path.join(contextDir, '.gitignore'), 'x\n')
    // Denying execute on `.context` makes `lstat` on its child fail with
    // EACCES rather than the ENOENT the helper already tolerates.
    fs.chmodSync(contextDir, 0o000)

    try {
      const { exitCode, stdout, stderr } = runHelper(root)

      // Contract: exit 2 with a fixed blocked reason -- never exit 1 from an
      // uncaught exception, and never a bare crash.
      expect(exitCode).toBe(2)
      const parsed = parseJsonRecord(stdout)
      expect(parsed.status).toBe('blocked')
      expect(typeof parsed.reason).toBe('string')
      // No raw Node error message, stack trace, or absolute path anywhere in
      // stdout/stderr.
      expect(stdout).not.toContain(root)
      expect(stderr).not.toContain(root)
      expect(stderr).not.toContain('EACCES')
      expect(stderr).not.toContain('    at ')
      expect(stderr).toBe('')
    } finally {
      fs.chmodSync(contextDir, 0o700)
    }
  })

  it('blocks (not symlink-rejected) on EACCES opening the ignore file itself', () => {
    if (isRoot) {
      return
    }
    const root = makeDir('ensure-ignore-eacces-file-')
    initRepo(root)
    const contextDir = path.join(root, '.context')
    fs.mkdirSync(contextDir)
    const ignorePath = path.join(contextDir, '.gitignore')
    fs.writeFileSync(ignorePath, 'existing\n')
    // Deny read on the file itself: lstat still succeeds (mode is readable
    // via directory listing) but `open()` for read fails with EACCES. This
    // must not be misclassified as a symlink.
    fs.chmodSync(ignorePath, 0o000)

    try {
      const { exitCode, stdout, stderr } = runHelper(root)

      expect(exitCode).toBe(2)
      const parsed = parseJsonRecord(stdout)
      expect(parsed.status).toBe('blocked')
      expect(parsed.reason).not.toBe('symlink-rejected')
      expect(stdout).not.toContain(root)
      expect(stderr).toBe('')
    } finally {
      fs.chmodSync(ignorePath, 0o644)
    }
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

describe('ensure-ignore CLI: bounded read / size cap on the ignore file', () => {
  it('blocks an oversize unprotected ignore file rather than reading and appending to it', () => {
    const root = makeDir('ensure-ignore-cap-oversize-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    const oversize = Buffer.alloc(IGNORE_FILE_MAX_BYTES + 100, 'x')
    fs.writeFileSync(ignorePath, oversize)

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'ignore-file-too-large',
      status: 'blocked',
    })
    // Never mutated: same size, same bytes.
    expect(fs.statSync(ignorePath).size).toBe(IGNORE_FILE_MAX_BYTES + 100)
    expect(fs.readFileSync(ignorePath).equals(oversize)).toBe(true)
  })

  it('blocks an oversize ignore file that already contains the required entry (already-protected overcap still blocks)', () => {
    const root = makeDir('ensure-ignore-cap-oversize-protected-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    const filler = Buffer.alloc(
      IGNORE_FILE_MAX_BYTES + 1 - ENTRY_LINE_LENGTH,
      'x',
    )
    const content = Buffer.concat([
      filler,
      Buffer.from('\n', 'utf8'),
      Buffer.from(`${REQUIRED_ENTRY}\n`, 'utf8'),
    ])
    fs.writeFileSync(ignorePath, content)
    expect(fs.statSync(ignorePath).size).toBeGreaterThan(IGNORE_FILE_MAX_BYTES)

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'ignore-file-too-large',
      status: 'blocked',
    })
  })

  it('blocks (unchanged) when the existing file is unprotected and near the cap such that the entry cannot fit', () => {
    const root = makeDir('ensure-ignore-cap-near-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    // No trailing newline, so composing needs a 1-byte separator plus the
    // full entry line -- pushing the composed length just past the cap.
    const existing = Buffer.alloc(IGNORE_FILE_MAX_BYTES - 5, 'x')
    fs.writeFileSync(ignorePath, existing)

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(2)
    expect(parseJsonRecord(stdout)).toEqual({
      reason: 'ignore-file-too-large',
      status: 'blocked',
    })
    // No temp file left behind, and the original file is byte-for-byte
    // unchanged -- the block happens before any write is attempted.
    expect(fs.readFileSync(ignorePath).equals(existing)).toBe(true)
    expect(fs.readdirSync(path.join(root, '.context'))).toEqual(['.gitignore'])
  })

  it('passes and is idempotent for an already-protected file at exactly the cap', () => {
    const root = makeDir('ensure-ignore-cap-exact-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    const entryLine = Buffer.from(`${REQUIRED_ENTRY}\n`, 'utf8')
    const filler = Buffer.alloc(
      IGNORE_FILE_MAX_BYTES - entryLine.length - 1,
      'x',
    )
    // A separating newline puts the entry on its own line, distinct from
    // the filler "line" that precedes it.
    const content = Buffer.concat([
      filler,
      Buffer.from('\n', 'utf8'),
      entryLine,
    ])
    fs.writeFileSync(ignorePath, content)
    expect(fs.statSync(ignorePath).size).toBe(IGNORE_FILE_MAX_BYTES)

    const { exitCode, stdout } = runHelper(root)

    expect(exitCode).toBe(0)
    expect(parseJsonRecord(stdout).status).toBe('protected')
    // Idempotent: bytes are untouched since the entry was already effective.
    expect(fs.readFileSync(ignorePath).equals(content)).toBe(true)
  })

  it('preserves non-UTF-8 bytes in a large-but-under-cap ignore file while appending the entry', () => {
    const root = makeDir('ensure-ignore-cap-nonutf8-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    const invalidUtf8Prefix = Buffer.from([0xff, 0xfe, 0x41, 0x42])
    const filler = Buffer.alloc(1024 * 512, 'x')
    const existing = Buffer.concat([
      invalidUtf8Prefix,
      Buffer.from('\n', 'utf8'),
      filler,
      Buffer.from('\n', 'utf8'),
    ])
    fs.writeFileSync(ignorePath, existing)

    const { exitCode } = runHelper(root)

    expect(exitCode).toBe(0)
    const resultBytes = fs.readFileSync(ignorePath)
    const expected = Buffer.concat([
      existing,
      Buffer.from(`${REQUIRED_ENTRY}\n`, 'utf8'),
    ])
    expect(resultBytes.equals(expected)).toBe(true)
  })
})

// ── Mid-read change detection: fault-injected in an isolated Node child ────
//
// Each script below monkeypatches `fs.readSync` on the shared `node:fs`
// default-export object *inside its own disposable child process* -- the
// helper module (`ensure-ignore.mjs`) imports the same `fs` default export
// via ESM sync-builtin-exports, so the patch reaches its calls too, without
// touching production source or any shared Bun worker. The patch is
// restored before the script exits. This is real `fs` I/O on a real temp
// fixture at a controlled point, not a timing-dependent race.

describe('ensure-ignore internals: mid-read change detection (fault-injected)', () => {
  it('does not return a stale prefix as trusted bytes when the file grows within the cap during the read', () => {
    const root = makeDir('ensure-ignore-fault-grow-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'original-content\n')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const originalReadSync = fs.readSync
      fs.readSync = function fault(...args) {
        const bytesRead = originalReadSync.apply(fs, args)
        fs.readSync = originalReadSync
        fs.appendFileSync(filePath, 'grown-during-read\\n')
        return bytesRead
      }

      let result
      try {
        result = readTrustedFile(filePath)
      } finally {
        fs.readSync = originalReadSync
      }

      assert.equal(result.exists, true)
      assert.equal(result.changed, true, 'expected an explicit changed result')
      assert.equal(result.symlink, undefined, 'must not be misclassified as symlink')
      assert.equal(result.tooLarge, undefined)
      assert.equal(result.bytes, undefined, 'must not hand back a stale/partial buffer')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('classifies growth-within-cap as a fixed failure (not symlink-rejected) at the ensureIgnore level', () => {
    const root = makeDir('ensure-ignore-fault-grow-ensure-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    fs.writeFileSync(ignorePath, 'unrelated-existing-line\n')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { ensureIgnore } from '${HELPER_URL}'

      const ignorePath = ${JSON.stringify(ignorePath)}
      const originalReadSync = fs.readSync
      fs.readSync = function fault(...args) {
        const bytesRead = originalReadSync.apply(fs, args)
        fs.readSync = originalReadSync
        fs.appendFileSync(ignorePath, 'grown-during-read\\n')
        return bytesRead
      }

      let outcome
      try {
        outcome = ensureIgnore(${JSON.stringify(root)})
      } finally {
        fs.readSync = originalReadSync
      }

      assert.equal(outcome.exitCode, 2)
      assert.equal(outcome.result.status, 'blocked')
      assert.notEqual(outcome.result.reason, 'symlink-rejected', 'must not misclassify an observed change as a symlink')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('does not misclassify a concurrent shrink (short read) as a symlink', () => {
    const root = makeDir('ensure-ignore-fault-shrink-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'x'.repeat(2000))

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const originalReadSync = fs.readSync
      fs.readSync = function fault(...args) {
        fs.readSync = originalReadSync
        fs.truncateSync(filePath, 10)
        return originalReadSync.apply(fs, args)
      }

      let result
      try {
        result = readTrustedFile(filePath)
      } finally {
        fs.readSync = originalReadSync
      }

      assert.equal(result.exists, true)
      assert.equal(result.changed, true, 'expected an explicit changed result, not a default empty buffer')
      assert.equal(result.symlink, undefined, 'must not recreate the N5 misclassification class')
      assert.equal(result.bytes, undefined)
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('classifies a concurrent shrink as a fixed failure (not symlink-rejected) at the ensureIgnore level', () => {
    const root = makeDir('ensure-ignore-fault-shrink-ensure-')
    initRepo(root)
    fs.mkdirSync(path.join(root, '.context'))
    const ignorePath = path.join(root, '.context', '.gitignore')
    fs.writeFileSync(ignorePath, 'x'.repeat(2000))

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { ensureIgnore } from '${HELPER_URL}'

      const ignorePath = ${JSON.stringify(ignorePath)}
      const originalReadSync = fs.readSync
      fs.readSync = function fault(...args) {
        fs.readSync = originalReadSync
        fs.truncateSync(ignorePath, 10)
        return originalReadSync.apply(fs, args)
      }

      let outcome
      try {
        outcome = ensureIgnore(${JSON.stringify(root)})
      } finally {
        fs.readSync = originalReadSync
      }

      assert.equal(outcome.exitCode, 2)
      assert.equal(outcome.result.status, 'blocked')
      assert.notEqual(outcome.result.reason, 'symlink-rejected')
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('still classifies growth that crosses the cap during the read as the oversize category (unchanged behavior, now proven under real fault injection)', () => {
    const root = makeDir('ensure-ignore-fault-cross-cap-')
    const filePath = path.join(root, '.gitignore')
    const nearCap = Buffer.alloc(IGNORE_FILE_MAX_BYTES - 100, 'x')
    fs.writeFileSync(filePath, nearCap)

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const originalReadSync = fs.readSync
      fs.readSync = function fault(...args) {
        const bytesRead = originalReadSync.apply(fs, args)
        fs.readSync = originalReadSync
        fs.appendFileSync(filePath, Buffer.alloc(500, 'y'))
        return bytesRead
      }

      let result
      try {
        result = readTrustedFile(filePath)
      } finally {
        fs.readSync = originalReadSync
      }

      assert.equal(result.exists, true)
      assert.equal(result.tooLarge, true)
      assert.equal(result.changed, undefined)
      assert.equal(result.symlink, undefined)
      assert.equal(result.bytes, undefined)
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('refuses to rename when the file crosses oversize between the write snapshot and the pre-rename recheck', () => {
    const root = makeDir('ensure-ignore-fault-recheck-oversize-')
    const filePath = path.join(root, '.gitignore')
    fs.writeFileSync(filePath, 'original\n')

    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { readTrustedFile, writeIgnoreFileIfUnchanged } from '${HELPER_URL}'

      const filePath = ${JSON.stringify(filePath)}
      const snapshot = readTrustedFile(filePath)

      // Real growth past the cap, performed directly (no readSync patch
      // needed: writeIgnoreFileIfUnchanged's recheck naturally observes
      // whatever is on disk at recheck time via the existing oversize path).
      fs.writeFileSync(filePath, Buffer.alloc(${1024 * 1024} + 1, 'z'))

      const result = writeIgnoreFileIfUnchanged(filePath, snapshot, 'original\\nappended\\n')
      assert.deepEqual(result, { ok: false, reason: 'conflict' })
      assert.equal(fs.readFileSync(filePath).length, ${1024 * 1024} + 1)
      process.exit(0)
    `

    const { exitCode, stderr } = runNodeHarness(script)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })
})
