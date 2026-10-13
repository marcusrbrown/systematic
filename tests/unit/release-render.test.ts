import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHANGELOG_SENTINEL } from '../../scripts/release/changelog.ts'
import { previewRelease } from '../../scripts/release/preview.ts'
import { renderReleasePr } from '../../scripts/release/render.ts'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const RELEASERC = path.join(REPO_ROOT, '.releaserc.yaml')
const RENDER_SCRIPT = path.join(REPO_ROOT, 'scripts/release/render.ts')
const TEST_TIMEOUT_MS = 30_000

const PREAMBLE =
  'This pull request publishes v1.0.1 when it merges. Merging requires an approval on this exact commit. The entry below is the release notes, generated from the commits since the last release.'

const tempDirs: string[] = []

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-render-fixture-'))
  tempDirs.push(dir)
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

function createOutDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-render-out-'))
  tempDirs.push(dir)
  return dir
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function countMatches(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('renderReleasePr', () => {
  test(
    'renders a new CHANGELOG, PR body and render.json for a patch release',
    async () => {
      const dir = createFixture()
      commit(dir, 'fix: handle empty config')
      const tip = commit(dir, 'fix: tolerate missing agent file')
      const outDir = path.join(createOutDir(), 'nested', 'out')

      const result = await renderReleasePr({ cwd: dir, sha: 'HEAD', outDir })

      const expected = {
        kind: 'release' as const,
        version: '1.0.1',
        title: 'chore(release): v1.0.1',
        baseSha: tip,
      }
      expect(result).toEqual(expected)
      expect(readJson(path.join(outDir, 'render.json'))).toEqual(expected)

      const changelog = fs.readFileSync(
        path.join(outDir, 'CHANGELOG.md'),
        'utf8',
      )
      expect(changelog).toContain('# Changelog')
      expect(changelog).toContain(CHANGELOG_SENTINEL)
      expect(changelog).toContain('## [1.0.1]')
      expect(changelog).toContain('handle empty config')
      expect(changelog).toContain('tolerate missing agent file')

      const body = fs.readFileSync(path.join(outDir, 'body.md'), 'utf8')
      expect(body.startsWith(`${PREAMBLE}\n\n## [1.0.1]`)).toBe(true)
      expect(body).toContain('handle empty config')
      expect(body).toContain('tolerate missing agent file')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'replaces a phantom entry for the pending version instead of duplicating it',
    async () => {
      const dir = createFixture()
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        [
          '# Changelog',
          '',
          CHANGELOG_SENTINEL,
          '',
          '## [1.0.1](https://example.com/compare/v1.0.0...v1.0.1) (2026-01-01)',
          '',
          '### Bug Fixes',
          '',
          '* phantom entry from an unpublished release',
          '',
        ].join('\n'),
      )
      git(dir, 'add', 'CHANGELOG.md')
      git(dir, 'commit', '-m', 'chore(release): v1.0.1')
      commit(dir, 'fix: real fix')
      const outDir = createOutDir()

      const result = await renderReleasePr({ cwd: dir, sha: 'HEAD', outDir })

      expect(result.kind).toBe('release')
      const changelog = fs.readFileSync(
        path.join(outDir, 'CHANGELOG.md'),
        'utf8',
      )
      expect(countMatches(changelog, '## [1.0.1]')).toBe(1)
      expect(changelog).toContain('real fix')
      expect(changelog).not.toContain('phantom entry')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'builds from the CHANGELOG.md committed at the sha, not the working tree',
    async () => {
      const dir = createFixture()
      const entry = (version: string, note: string) =>
        [
          `## [${version}](https://example.com/compare/v0...v${version}) (2026-01-01)`,
          '',
          '### Bug Fixes',
          '',
          `* ${note}`,
          '',
        ].join('\n')
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        [
          '# Changelog',
          '',
          CHANGELOG_SENTINEL,
          '',
          entry('1.0.0', 'committed-old-entry'),
        ].join('\n'),
      )
      git(dir, 'add', 'CHANGELOG.md')
      git(dir, 'commit', '-m', 'chore: add changelog')
      commit(dir, 'fix: real fix')
      // Dirty edit after committing: must not leak into the render.
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        [
          '# Changelog',
          '',
          CHANGELOG_SENTINEL,
          '',
          entry('1.0.0', 'working-tree-only-entry'),
        ].join('\n'),
      )
      const outDir = createOutDir()

      const result = await renderReleasePr({ cwd: dir, sha: 'HEAD', outDir })

      expect(result.kind).toBe('release')
      const changelog = fs.readFileSync(
        path.join(outDir, 'CHANGELOG.md'),
        'utf8',
      )
      expect(changelog).toContain('committed-old-entry')
      expect(changelog).not.toContain('working-tree-only-entry')
      expect(changelog).toContain('real fix')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'treats a CHANGELOG.md absent at the sha as new even if the working tree has one',
    async () => {
      const dir = createFixture()
      const older = commit(dir, 'fix: early fix')
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\nworking-tree-only-content\n',
      )
      git(dir, 'add', 'CHANGELOG.md')
      git(dir, 'commit', '-m', 'chore: add changelog later')
      const outDir = createOutDir()

      const result = await renderReleasePr({ cwd: dir, sha: older, outDir })

      expect(result.kind).toBe('release')
      const changelog = fs.readFileSync(
        path.join(outDir, 'CHANGELOG.md'),
        'utf8',
      )
      expect(changelog).not.toContain('working-tree-only-content')
      expect(changelog).toContain('early fix')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'only chore commits yield kind none and write no CHANGELOG or body',
    async () => {
      const dir = createFixture()
      commit(dir, 'chore: tidy')
      commit(dir, 'chore: tidy again')
      const outDir = createOutDir()

      const result = await renderReleasePr({ cwd: dir, sha: 'HEAD', outDir })

      expect(result).toEqual({ kind: 'none' })
      expect(readJson(path.join(outDir, 'render.json'))).toEqual({
        kind: 'none',
      })
      expect(fs.existsSync(path.join(outDir, 'CHANGELOG.md'))).toBe(false)
      expect(fs.existsSync(path.join(outDir, 'body.md'))).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'throws when the existing CHANGELOG.md has no sentinel',
    async () => {
      const dir = createFixture()
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [1.0.0]\n\nold notes\n',
      )
      git(dir, 'add', 'CHANGELOG.md')
      git(dir, 'commit', '-m', 'docs: add changelog')
      commit(dir, 'fix: real fix')
      const outDir = createOutDir()

      await expect(
        renderReleasePr({ cwd: dir, sha: 'HEAD', outDir }),
      ).rejects.toThrow(/sentinel/)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a chore(release) commit alone is non-releasing under the repo rules',
    async () => {
      const dir = createFixture()
      commit(dir, 'chore(release): v1.0.1')

      const result = await previewRelease({ cwd: dir, targetSha: 'HEAD' })

      expect(result).toEqual({ kind: 'none' })
    },
    TEST_TIMEOUT_MS,
  )
})

describe('render.ts CLI', () => {
  test(
    'exits 1 with an ::error:: line when --sha is bad',
    () => {
      const dir = createFixture()
      commit(dir, 'fix: real fix')
      const outDir = createOutDir()

      const result = spawnSync(
        'bun',
        [RENDER_SCRIPT, '--sha', 'does-not-exist', '--out', outDir],
        {
          cwd: dir,
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: dir },
        },
      )

      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain('::error::render failed:')
    },
    TEST_TIMEOUT_MS,
  )
})
