import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UserLevelConfigDirOptions } from '../../src/lib/search-user-config.js'
import type { createTempDirTracker } from './temp-dirs.js'

/**
 * An isolated home directory and checkout for `kind: "external"` tests, so no
 * test ever reads the real user config. `configOptions` points the reader at
 * the temp home and clears `OPENCODE_CONFIG_DIR`.
 */
export interface ExternalEnv {
  /** The temp directory holding everything below. */
  readonly root: string
  /** A checkout root: a directory holding a `.git` directory. */
  readonly repo: string
  readonly homeDir: string
  readonly userConfigDir: string
  readonly configOptions: UserLevelConfigDirOptions
}

type Tracker = ReturnType<typeof createTempDirTracker>

export function makeExternalEnv(temp: Tracker): ExternalEnv {
  const root = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-external-'))),
  )
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  const homeDir = path.join(root, 'home')
  const userConfigDir = path.join(homeDir, '.config/opencode')
  fs.mkdirSync(userConfigDir, { recursive: true })
  return {
    root,
    repo,
    homeDir,
    userConfigDir,
    configOptions: { homeDir, customConfigDir: null },
  }
}

/** Write the user config file with the given `search` block (or raw text). */
export function writeUserSearch(env: ExternalEnv, search: unknown): void {
  fs.writeFileSync(
    path.join(env.userConfigDir, 'systematic.json'),
    typeof search === 'string' ? search : JSON.stringify({ search }),
  )
}

/** Write the user-level local overlay beside the user config file. */
export function writeUserLocalSearch(env: ExternalEnv, search: unknown): void {
  fs.writeFileSync(
    path.join(env.userConfigDir, 'systematic.local.json'),
    typeof search === 'string' ? search : JSON.stringify({ search }),
  )
}

/**
 * Write the project config file with the given `search` block. The default
 * location is `.opencode/systematic.json`; `'root'` writes the repo-root
 * `.systematic.json` instead.
 */
export function writeProjectSearch(
  env: ExternalEnv,
  search: unknown,
  location: 'opencode' | 'root' = 'opencode',
): void {
  const body = JSON.stringify({ search })
  if (location === 'root') {
    fs.writeFileSync(path.join(env.repo, '.systematic.json'), body)
    return
  }
  const dir = path.join(env.repo, '.opencode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'systematic.json'), body)
}

/** Write a Markdown file under `dir` (creating it) with a `title` and an optional `status`. */
export function writeMarkdown(
  dir: string,
  relative: string,
  options: { title: string; body: string; status?: string },
): void {
  const target = path.join(dir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const status =
    options.status === undefined ? '' : `status: ${options.status}\n`
  fs.writeFileSync(
    target,
    `---\ntitle: ${options.title}\n${status}---\n\n${options.body}\n`,
  )
}

/** A user-level source mapped to `projects` (the checkout's main root by default). */
export function userSource(
  env: ExternalEnv,
  name: string,
  root: string,
  projects: readonly string[] = [env.repo],
) {
  return { name, format: 'markdown', roots: [root], projects: [...projects] }
}
