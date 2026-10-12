import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { buildGatedReleaseConfig } from '../../scripts/release/gated-config.ts'
import { dryRunRelease } from '../../scripts/release/preview.ts'

const REPO_ROOT = path.resolve(import.meta.dir, '../..')
const RELEASERC = path.join(REPO_ROOT, '.releaserc.yaml')
const GATED_CONFIG_SCRIPT = path.join(
  REPO_ROOT,
  'scripts/release/gated-config.ts',
)
const TEST_TIMEOUT_MS = 30_000

const releasercYaml = fs.readFileSync(RELEASERC, 'utf8')
const parsedYaml = yaml.load(releasercYaml) as Record<string, unknown>

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

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

/** Throwaway repo: initial commit tagged v1.0.0, then one fix commit. */
function createFixture(): string {
  const dir = makeTempDir('gated-config-fixture-')
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'commit', '--allow-empty', '-m', 'chore: initial commit')
  git(dir, 'tag', 'v1.0.0')
  git(dir, 'commit', '--allow-empty', '-m', 'fix: repair the thing')
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildGatedReleaseConfig', () => {
  const input = {
    releasercYaml,
    notesPath: 'release-notes/notes.md',
    version: '3.22.0',
  }

  test('keeps every non-plugin key from .releaserc.yaml unchanged', () => {
    const config = buildGatedReleaseConfig(input) as Record<string, unknown>
    const { plugins: _yamlPlugins, ...expected } = parsedYaml
    const { plugins: _configPlugins, ...actual } = config

    expect(actual).toEqual(expected)
    expect(Object.keys(actual)).toEqual(
      expect.arrayContaining([
        'branches',
        'tagFormat',
        'preset',
        'presetConfig',
        'analyzeCommits',
      ]),
    )
  })

  test('replaces plugins with the exact gated list', () => {
    const config = buildGatedReleaseConfig(input) as Record<string, unknown>

    expect(config.plugins).toEqual([
      '@semantic-release/commit-analyzer',
      [
        '@semantic-release/exec',
        {
          verifyReleaseCmd: 'test "$' + '{nextRelease.version}" = "3.22.0"',
          generateNotesCmd: "cat 'release-notes/notes.md'",
        },
      ],
      '@semantic-release/npm',
      [
        '@semantic-release/github',
        {
          releasedLabels: false,
          successComment: false,
          failComment: false,
          failTitle: false,
        },
      ],
      'semantic-release-export-data',
    ])
    expect(JSON.stringify(config.plugins)).not.toContain(
      'release-notes-generator',
    )
  })

  test('is pure data (survives a JSON round trip)', () => {
    const config = buildGatedReleaseConfig(input)
    expect(JSON.parse(JSON.stringify(config))).toEqual(config)
  })

  test('rejects an unsafe version', () => {
    for (const version of ['3.22.0; rm -rf /', 'v3.22.0', '3.22', '3.22.0\n']) {
      expect(() => buildGatedReleaseConfig({ ...input, version })).toThrow()
    }
  })

  test('rejects an unsafe notesPath', () => {
    for (const notesPath of ['a b', '$(x)', "a'b", 'a;b', '', 'a\nb']) {
      expect(() => buildGatedReleaseConfig({ ...input, notesPath })).toThrow()
    }
  })

  test('requires branches and tagFormat in the yaml', () => {
    expect(() =>
      buildGatedReleaseConfig({
        ...input,
        releasercYaml: `tagFormat: 'v\${version}'\n`,
      }),
    ).toThrow(/branches/)
    expect(() =>
      buildGatedReleaseConfig({
        ...input,
        releasercYaml: 'branches:\n  - main\n',
      }),
    ).toThrow(/tagFormat/)
  })
})

describe('gated config with real semantic-release core', () => {
  const NOTES =
    '## 1.0.1 (2026-01-01)\n\n### Bug Fixes\n\n* approved notes body\n'

  function gatedOptions(
    notesPath: string,
    version: string,
  ): Record<string, unknown> {
    const config = buildGatedReleaseConfig({
      releasercYaml,
      notesPath,
      version,
    }) as Record<string, unknown> & { plugins: unknown[] }
    // npm and github need credentials; keep only analyzer + exec.
    return { ...config, plugins: config.plugins.slice(0, 2) }
  }

  test(
    'exec generateNotesCmd output is used verbatim as the release notes',
    async () => {
      const dir = createFixture()
      const notesPath = path.join(makeTempDir('gated-config-notes-'), 'n.md')
      fs.writeFileSync(notesPath, NOTES)

      const result = await dryRunRelease({
        cwd: dir,
        targetSha: 'HEAD',
        options: gatedOptions(notesPath, '1.0.1'),
      })

      expect(result).not.toBe(false)
      if (!result) return
      expect(result.nextRelease.version).toBe('1.0.1')
      expect(result.nextRelease.notes?.trim()).toBe(NOTES.trim())
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'verifyReleaseCmd fails the run when the computed version differs',
    async () => {
      const dir = createFixture()
      const notesPath = path.join(makeTempDir('gated-config-notes-'), 'n.md')
      fs.writeFileSync(notesPath, NOTES)

      const error = await dryRunRelease({
        cwd: dir,
        targetSha: 'HEAD',
        options: gatedOptions(notesPath, '1.0.2'),
      }).then(
        () => null,
        (caught: unknown) => caught,
      )

      expect(error).not.toBeNull()
      const codes = ((error as { errors?: unknown[] }).errors ?? []).map(
        (e) => (e as { code?: unknown }).code,
      )
      expect(codes).toContain('EVERIFYRELEASE')
    },
    TEST_TIMEOUT_MS,
  )
})

describe('gated-config CLI', () => {
  test('writes JSON that round-trips to the same object', () => {
    const outDir = makeTempDir('gated-config-cli-')
    const out = path.join(outDir, 'nested', '.releaserc.json')

    const result = spawnSync(
      'bun',
      [
        GATED_CONFIG_SCRIPT,
        '--releaserc',
        RELEASERC,
        '--notes',
        'release-notes/notes.md',
        '--version',
        '3.22.0',
        '--out',
        out,
      ],
      { encoding: 'utf8' },
    )

    expect(result.status).toBe(0)
    const written = fs.readFileSync(out, 'utf8')
    expect(written.endsWith('\n')).toBe(true)
    expect(JSON.parse(written)).toEqual(
      buildGatedReleaseConfig({
        releasercYaml,
        notesPath: 'release-notes/notes.md',
        version: '3.22.0',
      }),
    )
  })

  test('exits non-zero on an unsafe version', () => {
    const out = path.join(makeTempDir('gated-config-cli-'), 'out.json')
    const result = spawnSync(
      'bun',
      [
        GATED_CONFIG_SCRIPT,
        '--releaserc',
        RELEASERC,
        '--notes',
        'n.md',
        '--version',
        '3.22.0; rm -rf /',
        '--out',
        out,
      ],
      { encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(fs.existsSync(out)).toBe(false)
  })
})
