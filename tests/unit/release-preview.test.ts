import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { previewRelease } from '../../scripts/release/preview.ts'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const RELEASERC = path.join(REPO_ROOT, '.releaserc.yaml')
const TEMP_PREFIX = 'systematic-release-preview-'
const TEST_TIMEOUT_MS = 30_000

const fixtures: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Throwaway repo with an initial commit tagged v1.0.0 and the real .releaserc.yaml. */
function createFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-fixture-'))
  fixtures.push(dir)
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.copyFileSync(RELEASERC, path.join(dir, '.releaserc.yaml'))
  commit(dir, 'chore: initial commit')
  git(dir, 'tag', 'v1.0.0')
  return dir
}

function commit(dir: string, ...messages: string[]): string {
  const args = ['commit', '--allow-empty']
  for (const message of messages) args.push('-m', message)
  git(dir, ...args)
  return git(dir, 'rev-parse', 'HEAD')
}

function snapshot(dir: string): Record<string, string> {
  return {
    config: git(dir, 'config', '--local', '--list'),
    refs: git(dir, 'for-each-ref'),
    tags: git(dir, 'tag', '-l'),
    head: git(dir, 'rev-parse', 'HEAD'),
    status: git(dir, 'status', '--porcelain'),
  }
}

function leftoverTempDirs(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(TEMP_PREFIX))
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('previewRelease', () => {
  test(
    'two fix commits yield a patch release with Bug Fixes notes',
    async () => {
      const dir = createFixture()
      commit(dir, 'fix: handle empty config')
      commit(dir, 'fix: tolerate missing agent file')

      const result = await previewRelease({ cwd: dir, targetSha: 'HEAD' })

      expect(result.kind).toBe('release')
      if (result.kind !== 'release') return
      expect(result.version).toBe('1.0.1')
      expect(result.gitTag).toBe('v1.0.1')
      expect(result.notes).toContain('handle empty config')
      expect(result.notes).toContain('tolerate missing agent file')
      expect(result.notes).toContain('Bug Fixes')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a feat among chores yields a minor release',
    async () => {
      const dir = createFixture()
      commit(dir, 'chore: tidy')
      commit(dir, 'feat: add preview command')
      commit(dir, 'chore: tidy again')

      const result = await previewRelease({ cwd: dir, targetSha: 'HEAD' })

      expect(result.kind).toBe('release')
      if (result.kind !== 'release') return
      expect(result.version).toBe('1.1.0')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'only chore and test commits yield no release',
    async () => {
      const dir = createFixture()
      commit(dir, 'chore: tidy')
      commit(dir, 'test: add coverage')

      const result = await previewRelease({ cwd: dir, targetSha: 'HEAD' })

      expect(result).toEqual({ kind: 'none' })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'repo releaseRules: docs(readme) is a patch, build(dev) alone is none',
    async () => {
      const docsDir = createFixture()
      commit(docsDir, 'docs(readme): clarify install steps')
      const docs = await previewRelease({ cwd: docsDir, targetSha: 'HEAD' })
      expect(docs.kind).toBe('release')
      if (docs.kind === 'release') expect(docs.version).toBe('1.0.1')

      const buildDir = createFixture()
      commit(buildDir, 'build(dev): bump tooling')
      const build = await previewRelease({ cwd: buildDir, targetSha: 'HEAD' })
      expect(build).toEqual({ kind: 'none' })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'breaking changes yield a major release (bang and footer)',
    async () => {
      const bangDir = createFixture()
      commit(bangDir, 'feat!: drop legacy config')
      const bang = await previewRelease({ cwd: bangDir, targetSha: 'HEAD' })
      expect(bang.kind).toBe('release')
      if (bang.kind === 'release') expect(bang.version).toBe('2.0.0')

      const footerDir = createFixture()
      commit(
        footerDir,
        'fix: change output shape',
        'BREAKING CHANGE: output is now an object',
      )
      const footer = await previewRelease({ cwd: footerDir, targetSha: 'HEAD' })
      expect(footer.kind).toBe('release')
      if (footer.kind === 'release') expect(footer.version).toBe('2.0.0')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'notes link to the real GitHub repo, not the local mirror',
    async () => {
      const dir = createFixture()
      commit(dir, 'fix: something broken')

      const result = await previewRelease({ cwd: dir, targetSha: 'HEAD' })

      expect(result.kind).toBe('release')
      if (result.kind !== 'release') return
      expect(result.notes).toContain(
        'https://github.com/marcusrbrown/systematic/compare/v1.0.0...v1.0.1',
      )
      expect(result.notes).toContain(
        'https://github.com/marcusrbrown/systematic/commit/',
      )
      expect(result.notes).not.toContain('file://')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'leaves the fixture repo and the temp directory untouched',
    async () => {
      const dir = createFixture()
      commit(dir, 'fix: something broken')
      const before = snapshot(dir)
      const tmpBefore = leftoverTempDirs()

      const result = await previewRelease({ cwd: dir, targetSha: 'HEAD' })

      expect(result.kind).toBe('release')
      expect(snapshot(dir)).toEqual(before)
      expect(leftoverTempDirs()).toEqual(tmpBefore)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'cleans up the temp directory when the preview fails',
    async () => {
      const dir = createFixture()
      const tmpBefore = leftoverTempDirs()

      await expect(
        previewRelease({ cwd: dir, targetSha: 'does-not-exist' }),
      ).rejects.toThrow()

      expect(leftoverTempDirs()).toEqual(tmpBefore)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'an older targetSha previews only up to that commit',
    async () => {
      const dir = createFixture()
      const older = commit(dir, 'fix: early fix')
      commit(dir, 'feat: later feature')
      commit(dir, 'fix: later fix')

      const result = await previewRelease({ cwd: dir, targetSha: older })

      expect(result.kind).toBe('release')
      if (result.kind !== 'release') return
      expect(result.version).toBe('1.0.1')
      expect(result.notes).toContain('early fix')
      expect(result.notes).not.toContain('later feature')
      expect(result.notes).not.toContain('later fix')
    },
    TEST_TIMEOUT_MS,
  )
})
