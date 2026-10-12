import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { renderChangelog } from './changelog.js'
import { previewRelease } from './preview.js'

const execFileAsync = promisify(execFile)

export type RenderJson =
  | { kind: 'none' }
  | {
      kind: 'release'
      version: string
      title: string
      baseSha: string
    }

export interface RenderOptions {
  cwd: string
  sha: string
  outDir: string
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args])
  return stdout.trim()
}

function prBody(version: string, entry: string): string {
  return [
    `This pull request publishes v${version} when it merges. Merging requires an approval on this exact commit. The entry below is the release notes, generated from the commits since the last release.`,
    '',
    entry,
  ].join('\n')
}

function readChangelog(cwd: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, 'CHANGELOG.md'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function writeRenderJson(outDir: string, render: RenderJson): void {
  fs.writeFileSync(
    path.join(outDir, 'render.json'),
    `${JSON.stringify(render)}\n`,
  )
}

/** Render the pending release PR content (CHANGELOG.md, body.md, render.json) into `outDir`. */
export async function renderReleasePr({
  cwd,
  sha,
  outDir,
}: RenderOptions): Promise<RenderJson> {
  fs.mkdirSync(outDir, { recursive: true })

  const baseSha = await git(cwd, 'rev-parse', '--verify', `${sha}^{commit}`)
  const preview = await previewRelease({ cwd, targetSha: baseSha })

  if (preview.kind === 'none') {
    const none: RenderJson = { kind: 'none' }
    writeRenderJson(outDir, none)
    return none
  }

  const { version, notes } = preview
  const existingTags = new Set(
    (await git(cwd, 'tag', '-l', 'v*'))
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
  )
  const changelog = renderChangelog({
    current: readChangelog(cwd),
    entry: notes,
    version,
    existingTags,
  })

  fs.writeFileSync(path.join(outDir, 'CHANGELOG.md'), changelog)
  fs.writeFileSync(path.join(outDir, 'body.md'), prBody(version, notes.trim()))

  const release: RenderJson = {
    kind: 'release',
    version,
    title: `chore(release): v${version}`,
    baseSha,
  }
  writeRenderJson(outDir, release)
  return release
}

function parseArgs(argv: string[]): { sha: string; out: string } {
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
  if (out === undefined || out === '') throw new Error('--out is required')
  return { sha, out }
}

if (import.meta.main) {
  try {
    const { sha, out } = parseArgs(process.argv.slice(2))
    const result = await renderReleasePr({
      cwd: process.cwd(),
      sha,
      outDir: out,
    })
    process.stdout.write(
      result.kind === 'release'
        ? `release ${result.version}\n`
        : 'no release\n',
    )
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(/\s*\r?\n\s*/g, ' ')
      .trim()
    process.stdout.write(`::error::render failed: ${message}\n`)
    process.exit(1)
  }
}
