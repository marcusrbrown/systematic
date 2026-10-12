import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import yaml from 'js-yaml'
import semanticRelease, { type PluginSpec } from 'semantic-release'

const execFileAsync = promisify(execFile)

/**
 * Real GitHub URL kept as `repositoryUrl` so release-note compare/commit links
 * are correct. Git is redirected to a local mirror via `url.<base>.insteadOf`.
 */
const REPOSITORY_URL = 'https://github.com/marcusrbrown/systematic.git'
const REPOSITORY_URL_ALIASES = [
  REPOSITORY_URL,
  REPOSITORY_URL.replace(/\.git$/, ''),
  `git+${REPOSITORY_URL}`,
  `git+${REPOSITORY_URL.replace(/\.git$/, '')}`,
]

const TEMP_PREFIX = 'systematic-release-preview-'

export type PreviewResult =
  | { kind: 'none' }
  | { kind: 'release'; version: string; gitTag: string; notes: string }

export interface PreviewOptions {
  cwd: string
  targetSha: string
}

interface ReleaseConfig {
  [key: string]: unknown
  plugins?: PluginSpec[]
}

const KEPT_PLUGINS = [
  '@semantic-release/commit-analyzer',
  '@semantic-release/release-notes-generator',
]

async function git(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env })
  return stdout.trim()
}

function loadReleaseConfig(cwd: string): ReleaseConfig {
  const raw = fs.readFileSync(path.join(cwd, '.releaserc.yaml'), 'utf8')
  const parsed = yaml.load(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('.releaserc.yaml must contain a mapping at the top level')
  }
  return parsed as ReleaseConfig
}

function createCapture(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

/**
 * Compute the pending release for `targetSha` by running real semantic-release
 * core in dry-run mode against an isolated temp clone. No credentials and no
 * network: push/fetch hit a local bare mirror, while `repositoryUrl` stays the
 * real GitHub URL so generated links are correct.
 */
export async function previewRelease({
  cwd,
  targetSha,
}: PreviewOptions): Promise<PreviewResult> {
  const config = loadReleaseConfig(cwd)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))

  try {
    // Isolate git from user/system config (signing, insteadOf, hooks, ...).
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }

    const sha = await git(
      cwd,
      env,
      'rev-parse',
      '--verify',
      `${targetSha}^{commit}`,
    )

    const mirror = path.join(tmp, 'remote.git')
    const work = path.join(tmp, 'work')

    await git(tmp, env, 'clone', '--bare', '--no-local', cwd, mirror)
    await git(mirror, env, 'update-ref', 'refs/heads/main', sha)
    await git(
      mirror,
      env,
      'fetch',
      '--force',
      '--no-write-fetch-head',
      cwd,
      'refs/tags/v*:refs/tags/v*',
    )

    await git(tmp, env, 'clone', mirror, work)
    await git(work, env, 'checkout', '-B', 'main', sha)
    for (const alias of REPOSITORY_URL_ALIASES) {
      await git(
        work,
        env,
        'config',
        '--local',
        '--add',
        `url.file://${mirror}.insteadOf`,
        alias,
      )
    }

    const { plugins: _plugins, ...rest } = config
    const plugins = (config.plugins ?? []).filter((entry) => {
      const name = Array.isArray(entry) ? entry[0] : entry
      return KEPT_PLUGINS.includes(name)
    })
    if (plugins.length !== KEPT_PLUGINS.length) {
      throw new Error(
        `.releaserc.yaml must declare ${KEPT_PLUGINS.join(' and ')}`,
      )
    }

    const stdout = createCapture() as unknown as NodeJS.WriteStream
    const stderr = createCapture() as unknown as NodeJS.WriteStream

    const result = await semanticRelease(
      {
        ...rest,
        dryRun: true,
        ci: false,
        branches: ['main'],
        repositoryUrl: REPOSITORY_URL,
        plugins,
      },
      { cwd: work, env, stdout, stderr },
    )

    if (!result) return { kind: 'none' }
    const { version, gitTag, notes } = result.nextRelease
    if (notes === undefined) {
      throw new Error('semantic-release returned a release without notes')
    }
    return { kind: 'release', version, gitTag, notes }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function parseArgs(argv: string[]): { sha: string; out: string | undefined } {
  let sha = 'HEAD'
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sha') {
      sha = argv[++i] ?? ''
    } else if (arg === '--out') {
      out = argv[++i]
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (sha === '') throw new Error('--sha requires a value')
  return { sha, out }
}

if (import.meta.main) {
  try {
    const { sha, out } = parseArgs(process.argv.slice(2))
    const result = await previewRelease({ cwd: process.cwd(), targetSha: sha })
    if (out !== undefined) {
      fs.mkdirSync(out, { recursive: true })
      const summary =
        result.kind === 'release'
          ? {
              kind: result.kind,
              version: result.version,
              gitTag: result.gitTag,
            }
          : { kind: result.kind }
      fs.writeFileSync(
        path.join(out, 'preview.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
      )
      if (result.kind === 'release') {
        fs.writeFileSync(path.join(out, 'notes.md'), result.notes)
      }
    }
    process.stdout.write(
      result.kind === 'release'
        ? `release ${result.version} (${result.gitTag})\n`
        : 'no release\n',
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  }
}
