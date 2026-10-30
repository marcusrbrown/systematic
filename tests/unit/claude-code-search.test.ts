import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSearchBundle,
  CLAUDE_CODE_SEARCH_BIN,
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.js'
import { runClaudeCodeSearch } from '../../src/claude-code-search.js'
import { SEARCH_CLI_DISABLED_NOTICE } from '../../src/lib/search-cli.js'
import { runSearch } from '../../src/lib/search-core.js'
import { NODE_BIN } from '../helpers/real-node.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

function makeDir(prefix: string): string {
  return temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
  )
}

function makeProject(): string {
  const root = makeDir('claude-code-search-')
  fs.mkdirSync(path.join(root, '.git'))
  const docs = path.join(root, 'docs/solutions')
  fs.mkdirSync(docs, { recursive: true })
  fs.writeFileSync(
    path.join(docs, 'zebra-flake.md'),
    '---\ntitle: Zebra crossing flake\nsymptoms:\n  - zebra flake on retry\ntags:\n  - zebra\n---\n\nThe zebra flake appears when retries overlap.\n',
  )
  return root
}

interface UserDirs {
  readonly home: string
  readonly userConfigDir: string
  readonly customDir: string
}

function makeUserDirs(): UserDirs {
  const home = makeDir('claude-code-search-home-')
  const userConfigDir = path.join(home, '.config/opencode')
  fs.mkdirSync(userConfigDir, { recursive: true })
  return { home, userConfigDir, customDir: makeDir('claude-code-search-cfg-') }
}

async function coreText(root: string, query: string): Promise<string> {
  return (await runSearch({ query }, { startDir: root })).text
}

async function runInProcess(
  root: string,
  dirs: UserDirs,
  argv: string[],
  withCustom = false,
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const status = await runClaudeCodeSearch({
    argv,
    cwd: root,
    userLevel: {
      homeDir: dirs.home,
      customConfigDir: withCustom ? dirs.customDir : null,
    },
    outputSink: (message) => stdout.push(message),
    errorSink: (message) => stderr.push(message),
  })
  return { status, stdout, stderr }
}

describe('runClaudeCodeSearch (in process)', () => {
  it('prints the core text and exits 0 with no config at all', async () => {
    const root = makeProject()
    const result = await runInProcess(root, makeUserDirs(), ['zebra', 'flake'])
    expect(result.status).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toEqual([await coreText(root, 'zebra flake')])
  })

  it('exits 2 for a usage error, like the CLI', async () => {
    const result = await runInProcess(makeProject(), makeUserDirs(), [
      'zebra',
      '--limit',
      '99',
    ])
    expect(result.status).toBe(2)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toHaveLength(1)
  })

  it('names its own command in --help and in a usage error', async () => {
    const help = await runInProcess(makeProject(), makeUserDirs(), ['--help'])
    expect(help.status).toBe(0)
    expect(help.stdout[0]).toContain('Usage: systematic-search <query...>')
    expect(help.stdout[0]).not.toContain('systematic search')
    const bad = await runInProcess(makeProject(), makeUserDirs(), [
      'zebra',
      '--bogus',
    ])
    expect(bad.status).toBe(2)
    expect(bad.stderr[0]).toContain('Usage: systematic-search <query...>')
    expect(bad.stderr[0]).not.toContain('systematic search')
  })

  it('prints disabled and exits 0 when the user config switches search off', async () => {
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    const result = await runInProcess(makeProject(), dirs, ['zebra'])
    expect(result.status).toBe(0)
    expect(result.stdout).toEqual([SEARCH_CLI_DISABLED_NOTICE])
    expect(result.stderr).toEqual([])
  })

  it('lets the OPENCODE_CONFIG_DIR file override the user file', async () => {
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    fs.writeFileSync(
      path.join(dirs.customDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: true } }),
    )
    const root = makeProject()
    const result = await runInProcess(root, dirs, ['zebra'], true)
    expect(result.stdout).toEqual([await coreText(root, 'zebra')])
  })

  it('reads a JSONC file with comments', async () => {
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.jsonc'),
      '// my settings\n{\n  /* search */\n  "search": {\n    "enabled": false // off for now\n  }\n}\n',
    )
    const result = await runInProcess(makeProject(), dirs, ['zebra'])
    expect(result.stdout).toEqual([SEARCH_CLI_DISABLED_NOTICE])
    expect(result.stderr).toEqual([])
  })

  it('never reads project config, even one that switches search off', async () => {
    const root = makeProject()
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode/systematic.json'),
      JSON.stringify({
        search: { enabled: false },
      }),
    )
    const result = await runInProcess(root, makeUserDirs(), ['zebra'])
    expect(result.status).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toEqual([await coreText(root, 'zebra')])
  })

  it('gives results with a config unreadable note for an unparseable file', async () => {
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.jsonc'),
      '{ "search": { "enabled": false, },\n}\n',
    )
    const root = makeProject()
    const result = await runInProcess(root, dirs, ['zebra'])
    expect(result.status).toBe(0)
    expect(result.stdout[0]).toContain('Notes: config unreadable')
    expect(result.stdout[0]).toContain('zebra-flake.md')
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toContain('could not be read')
    expect(result.stderr[0]).not.toContain('enabled')
  })

  it('drops an invalid search block alone: a warning naming the field, results, exit 0', async () => {
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: 'SECRET-VALUE-no' } }),
    )
    const result = await runInProcess(makeProject(), dirs, ['zebra'])
    expect(result.status).toBe(0)
    expect(result.stdout[0]).toContain('Notes: config unreadable')
    expect(result.stdout[0]).toContain('zebra-flake.md')
    expect(result.stderr).toHaveLength(1)
    expect(result.stderr[0]).toContain('search.enabled')
    expect(result.stderr[0]).not.toContain('SECRET-VALUE')
  })
})

/**
 * The built bin, run the way Claude Code runs it: under real `node`, from a
 * directory that holds no `node_modules`, with stdin closed and a timeout. This
 * run is also the import guard. If the bin pulled in `config.ts`, its UMD
 * jsonc build would crash here.
 */
describe('built systematic-search bin (foreign directory, real node)', () => {
  const bundleCache: { bundle?: Promise<Buffer> } = {}

  function bundle(): Promise<Buffer> {
    bundleCache.bundle ??= buildSearchBundle(ROOT_DIR)
    return bundleCache.bundle
  }

  /** Writes the bin the way the production build does, into a fresh dir. */
  async function installBin(): Promise<string> {
    const outDir = path.join(makeDir('claude-code-search-bin-'), 'plugin')
    const files = generatePluginFiles(
      ROOT_DIR,
      Buffer.from('placeholder validator bundle'),
      await bundle(),
    )
    const binOnly = new Map(
      [...files].filter(([rel]) => rel === `bin/${CLAUDE_CODE_SEARCH_BIN}`),
    )
    writePluginFiles(binOnly, outDir)
    return path.join(outDir, 'bin', CLAUDE_CODE_SEARCH_BIN)
  }

  function runBin(
    bin: string,
    args: string[],
    options: {
      cwd: string
      home: string
      customDir?: string
      direct?: boolean
    },
  ) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: options.home,
      USERPROFILE: options.home,
    }
    delete env.OPENCODE_CONFIG_DIR
    delete env.XDG_CONFIG_HOME
    if (options.customDir !== undefined) {
      env.OPENCODE_CONFIG_DIR = options.customDir
    }
    const result = spawnSync(
      options.direct === true ? bin : NODE_BIN,
      options.direct === true ? args : [bin, ...args],
      {
        cwd: options.cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }

  it('prints the same text as the core from a foreign directory, executed through its shebang', async () => {
    const bin = await installBin()
    const root = makeProject()
    const dirs = makeUserDirs()
    const fd = fs.openSync(bin, 'r')
    try {
      expect(fs.fstatSync(fd).mode & 0o111).toBe(0o111)
      expect(
        fs.readFileSync(fd, 'utf8').startsWith('#!/usr/bin/env node\n'),
      ).toBe(true)
    } finally {
      fs.closeSync(fd)
    }
    // No node_modules anywhere above the project or the bin.
    expect(fs.existsSync(path.join(path.dirname(root), 'node_modules'))).toBe(
      false,
    )

    const result = runBin(bin, ['zebra', 'flake'], {
      cwd: root,
      home: dirs.home,
      direct: true,
    })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${await coreText(root, 'zebra flake')}\n`)
  }, 60_000)

  it('reads a JSONC user config with comments and prints disabled', async () => {
    const bin = await installBin()
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.jsonc'),
      '// off\n{ /* c */ "search": { "enabled": false } }\n',
    )
    const result = runBin(bin, ['zebra'], {
      cwd: makeProject(),
      home: dirs.home,
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${SEARCH_CLI_DISABLED_NOTICE}\n`)
  }, 60_000)

  it('reads the OPENCODE_CONFIG_DIR file and lets it override the user file', async () => {
    const bin = await installBin()
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.json'),
      JSON.stringify({ search: { enabled: false } }),
    )
    fs.writeFileSync(
      path.join(dirs.customDir, 'systematic.jsonc'),
      '{ "search": { "enabled": true } } // back on\n',
    )
    const root = makeProject()
    const result = runBin(bin, ['zebra'], {
      cwd: root,
      home: dirs.home,
      customDir: dirs.customDir,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${await coreText(root, 'zebra')}\n`)
  }, 60_000)

  it('still returns results and exit 0 for an unparseable user config', async () => {
    const bin = await installBin()
    const dirs = makeUserDirs()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.jsonc'),
      '{ "search": { "enabled": false, },\n}\n',
    )
    const root = makeProject()
    const result = runBin(bin, ['zebra'], { cwd: root, home: dirs.home })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Notes: config unreadable')
    expect(result.stdout).toContain('docs/solutions/zebra-flake.md')
    expect(result.stderr).toContain('could not be read')
  }, 60_000)

  it('exits 2 with nothing on stdout for a usage error', async () => {
    const bin = await installBin()
    const result = runBin(bin, ['zebra', '--bogus'], {
      cwd: makeProject(),
      home: makeUserDirs().home,
    })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: systematic-search <query...>')
    expect(result.stderr).not.toContain('systematic search')
  }, 60_000)
})
