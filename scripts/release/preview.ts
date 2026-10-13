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

export type DryRunResult = Awaited<ReturnType<typeof semanticRelease>>

export interface DryRunOptions {
  cwd: string
  targetSha: string
  /** semantic-release options; dryRun, ci, branches and repositoryUrl are forced. */
  options: Record<string, unknown>
}

/**
 * Run real semantic-release core in dry-run mode against an isolated temp
 * clone of `cwd` checked out at `targetSha`. No credentials and no network:
 * push/fetch hit a local bare mirror, while `repositoryUrl` stays the real
 * GitHub URL so generated links are correct. The temp directory is always
 * removed.
 */
export async function dryRunRelease({
  cwd,
  targetSha,
  options,
}: DryRunOptions): Promise<DryRunResult> {
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

    const stdout = createCapture() as unknown as NodeJS.WriteStream
    const stderr = createCapture() as unknown as NodeJS.WriteStream

    return await semanticRelease(
      {
        ...options,
        dryRun: true,
        ci: false,
        branches: ['main'],
        repositoryUrl: REPOSITORY_URL,
      },
      { cwd: work, env, stdout, stderr },
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function pluginName(entry: PluginSpec): string {
  return Array.isArray(entry) ? entry[0] : entry
}

/**
 * The declared plugins reduced to exactly one entry each of KEPT_PLUGINS.
 * Anything else (missing, duplicated, or a non-list) is a config error.
 */
function selectKeptPlugins(declared: unknown): PluginSpec[] {
  if (!Array.isArray(declared)) {
    throw new Error('.releaserc.yaml plugins must be a list')
  }
  const kept = (declared as PluginSpec[]).filter((entry) =>
    KEPT_PLUGINS.includes(pluginName(entry)),
  )
  const names = new Set(kept.map(pluginName))
  const exact =
    kept.length === KEPT_PLUGINS.length &&
    names.size === KEPT_PLUGINS.length &&
    KEPT_PLUGINS.every((name) => names.has(name))
  if (!exact) {
    throw new Error(
      `.releaserc.yaml must declare ${KEPT_PLUGINS.join(' and ')}`,
    )
  }
  return kept
}

/** Compute the pending release for `targetSha` from the repo's `.releaserc.yaml`. */
export async function previewRelease({
  cwd,
  targetSha,
}: PreviewOptions): Promise<PreviewResult> {
  const { plugins: declaredPlugins, ...rest } = loadReleaseConfig(cwd)
  const plugins = selectKeptPlugins(declaredPlugins)

  const result = await dryRunRelease({
    cwd,
    targetSha,
    options: { ...rest, plugins },
  })

  if (!result) return { kind: 'none' }
  const { version, gitTag, notes } = result.nextRelease
  if (notes === undefined) {
    throw new Error('semantic-release returned a release without notes')
  }
  return { kind: 'release', version, gitTag, notes }
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
