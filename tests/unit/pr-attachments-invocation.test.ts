import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The helper decides whether it was run directly or imported. Node reports
// import.meta.url as a real path, but process.argv[1] is the path as typed, so
// a symlinked skill directory or helper file must still count as a direct run.
// Before the fix, such a run printed nothing and exited 0, which a caller
// reads as success.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SKILL_DIR = path.join(REPO_ROOT, 'skills/pr-attachments')
const HELPER_PATH = path.join(SKILL_DIR, 'scripts/pr-attachments.mjs')

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

interface Run {
  readonly status: number | null
  readonly stdout: string
}

function runNode(
  scriptPath: string,
  args: readonly string[],
  stdin: string,
): Run {
  const result = spawnSync('node', [scriptPath, ...args], {
    input: stdin,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout }
}

/** A path to the helper that goes through a symlinked file. */
function viaSymlinkedFile(): string {
  const link = path.join(makeTempDir('pr-att-file-link-'), 'helper.mjs')
  fs.symlinkSync(HELPER_PATH, link)
  return link
}

/** A path to the helper that goes through a symlinked skill directory. */
function viaSymlinkedDirectory(): string {
  const link = path.join(makeTempDir('pr-att-dir-link-'), 'pr-attachments')
  fs.symlinkSync(SKILL_DIR, link, 'dir')
  return path.join(link, 'scripts/pr-attachments.mjs')
}

const URLS_INPUT = JSON.stringify({
  body: 'No evidence here.',
  head_repo: 'o/r',
})

const entries = [
  ['the real path', () => HELPER_PATH],
  ['a symlinked file', viaSymlinkedFile],
  ['a symlinked skill directory', viaSymlinkedDirectory],
] as const

describe('pr-attachments helper -- direct invocation through symlinks', () => {
  for (const [label, resolveScript] of entries) {
    test(`reports a usage error with exit 2 for a bad operation, via ${label}`, () => {
      const run = runNode(resolveScript(), ['no-such-op'], '')
      expect(run.stdout, 'stdout must not be empty').not.toBe('')
      const body = JSON.parse(run.stdout)
      expect(body.result).toBe('usage-error')
      expect(body.error).toBe('unknown-operation')
      expect(run.status).toBe(2)
    })

    test(`returns a normal result for a valid operation, via ${label}`, () => {
      const run = runNode(resolveScript(), ['urls'], URLS_INPUT)
      expect(run.stdout, 'stdout must not be empty').not.toBe('')
      const body = JSON.parse(run.stdout)
      expect(body.operation).toBe('urls')
      expect(body.result).toBe('urls')
      expect(run.status).toBe(0)
    })
  }
})

describe('pr-attachments helper -- import', () => {
  test('importing the module does not run main', () => {
    const script = `import(${JSON.stringify(HELPER_PATH)}).then(() => process.stdout.write('imported'))`
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      input: '',
    })
    expect(result.stdout).toBe('imported')
    expect(result.status).toBe(0)
  })
})
