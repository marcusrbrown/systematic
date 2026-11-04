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
import {
  SEARCH_CLI_DISABLED_NOTICE,
  SEARCH_CLI_PROJECT_CONFIG_WARNING,
} from '../../src/lib/search-cli.js'
import { runSearch } from '../../src/lib/search-core.js'
import type { UserLevelConfigDirOptions } from '../../src/lib/search-user-config.js'
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

/** The `external` text the core gives for `root`, reading the user config the bin is pointed at. */
async function externalCoreText(
  root: string,
  query: string,
  configOptions: UserLevelConfigDirOptions,
): Promise<string> {
  return (
    await runSearch(
      { query, kind: 'external' },
      { startDir: root, configOptions },
    )
  ).text
}

/** `docs/decisions/` holds a zebra decision; a project config proposes it as the `decisions` source. */
function proposeDecisions(root: string, projectFile = 'systematic.json'): void {
  const decisions = path.join(root, 'docs/decisions')
  fs.mkdirSync(decisions, { recursive: true })
  fs.writeFileSync(
    path.join(decisions, 'zebra-rollback.md'),
    '---\ntitle: Zebra rollback decision\nstatus: accepted\n---\n\nWe roll the zebra flake fix back when retries overlap.\n',
  )
  fs.mkdirSync(path.join(root, '.opencode'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.opencode', projectFile),
    projectFile.endsWith('.jsonc')
      ? '// the sources this project proposes\n{ "search": { "sources": [ /* one */ { "name": "decisions", "format": "markdown", "roots": ["docs/decisions"] } ] } }\n'
      : JSON.stringify({
          search: {
            sources: [
              {
                name: 'decisions',
                format: 'markdown',
                roots: ['docs/decisions'],
              },
            ],
          },
        }),
  )
}

/** Allow `root` in the user config of `dirs`, in the file chosen by `file`. */
function allowProject(
  directory: string,
  root: string,
  file = 'systematic.json',
): void {
  fs.writeFileSync(
    path.join(directory, file),
    JSON.stringify({ search: { allow_project_sources: [root] } }),
  )
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

describe('runClaudeCodeSearch --kind external (in process)', () => {
  function setup() {
    const root = makeProject()
    proposeDecisions(root)
    const dirs = makeUserDirs()
    return { root, dirs }
  }

  it('hands userLevel to the external reader, not only to the settings loader', async () => {
    const { root, dirs } = setup()
    allowProject(dirs.userConfigDir, root)
    const expected = await externalCoreText(root, 'zebra', {
      homeDir: dirs.home,
      customConfigDir: null,
    })
    expect(expected).toContain('decisions (project)')

    const result = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])

    expect(result.status).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toEqual([expected])
  })

  it('reads the allow list from the custom config directory it was given', async () => {
    const { root, dirs } = setup()
    allowProject(dirs.customDir, root)
    const result = await runInProcess(
      root,
      dirs,
      ['zebra', '--kind', 'external'],
      true,
    )
    expect(result.stdout[0]).toContain('decisions (project)')

    const without = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])
    expect(without.stdout[0]).toContain('search.allow_project_sources')
    expect(without.stdout[0]).not.toContain('decisions (project)')
  })

  it('uses the start directory it is given to find the project file', async () => {
    const { root, dirs } = setup()
    allowProject(dirs.userConfigDir, root)
    const sub = path.join(root, 'docs')
    const result = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
      '--dir',
      sub,
    ])
    expect(result.stdout[0]).toContain('decisions (project)')
  })

  it('prints one stderr warning and the aggregate line for a structurally broken project file, for external only', async () => {
    const root = makeProject()
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(
      path.join(root, '.opencode/systematic.json'),
      '{ "search": { "sources": "SECRET-VALUE-not-an-array" } }',
    )
    const dirs = makeUserDirs()

    const external = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])
    expect(external.status).toBe(0)
    expect(external.stderr).toHaveLength(1)
    expect(external.stderr[0]).not.toContain('SECRET-VALUE')
    expect(external.stdout[0]).toContain(
      'Project sources: the project config could not be read, so it proposes none.',
    )
    expect(external.stdout[0]).not.toContain('SECRET-VALUE')

    const builtin = await runInProcess(root, dirs, ['zebra'])
    expect(builtin.stderr).toEqual([])
    expect(builtin.stdout).toEqual([await coreText(root, 'zebra')])
  })

  it('prints no stderr line for an invalid entry next to a valid one: the entry warning rides in the reply', async () => {
    const { root, dirs } = setup()
    fs.writeFileSync(
      path.join(root, '.opencode/systematic.json'),
      JSON.stringify({
        search: {
          sources: [
            {
              name: 'decisions',
              format: 'markdown',
              roots: ['docs/decisions'],
            },
            { name: 'bad', format: 'markdown', roots: ['.'] },
          ],
        },
      }),
    )
    allowProject(dirs.userConfigDir, root)
    const result = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])
    expect(result.stderr).toEqual([])
    expect(result.stdout[0]).toContain('decisions (project)')
    expect(result.stdout[0]).toContain('Warnings:')
  })

  it('reads a JSONC project file with comments, and prefers it over the .json beside it', async () => {
    const { root, dirs } = setup()
    fs.writeFileSync(
      path.join(root, '.opencode/systematic.json'),
      JSON.stringify({ search: { sources: [] } }),
    )
    proposeDecisions(root, 'systematic.jsonc')
    allowProject(dirs.userConfigDir, root)
    const result = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])
    expect(result.stdout[0]).toContain('decisions (project)')
  })

  it('search.enabled false in the user config suppresses external too', async () => {
    const { root, dirs } = setup()
    fs.writeFileSync(
      path.join(dirs.userConfigDir, 'systematic.json'),
      JSON.stringify({
        search: { enabled: false, allow_project_sources: [root] },
      }),
    )
    const result = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])
    expect(result.stdout).toEqual([SEARCH_CLI_DISABLED_NOTICE])
  })

  it('a project file cannot switch search off or allow itself', async () => {
    const { root, dirs } = setup()
    fs.writeFileSync(
      path.join(root, '.opencode/systematic.json'),
      JSON.stringify({
        search: {
          enabled: false,
          allow_project_sources: [root],
          sources: [
            {
              name: 'decisions',
              format: 'markdown',
              roots: ['docs/decisions'],
            },
          ],
        },
      }),
    )
    const result = await runInProcess(root, dirs, [
      'zebra',
      '--kind',
      'external',
    ])
    expect(result.stdout[0]).toContain('search.allow_project_sources')
    expect(result.stdout[0]).not.toContain('decisions (project)')
  })
})

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

  it('reads only sources from project config: a project file that switches search off changes nothing', async () => {
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
  const bundleCache: { build?: ReturnType<typeof buildSearchBundle> } = {}

  function build(): ReturnType<typeof buildSearchBundle> {
    bundleCache.build ??= buildSearchBundle(ROOT_DIR)
    return bundleCache.build
  }

  async function bundle(): Promise<Buffer> {
    return (await build()).bundle
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

  it('runs --kind external from a foreign directory: reads the user allow list and the JSONC project file at the start directory it is passed', async () => {
    const bin = await installBin()
    const root = makeProject()
    proposeDecisions(root, 'systematic.jsonc')
    const dirs = makeUserDirs()
    allowProject(dirs.userConfigDir, root, 'systematic.jsonc')
    const expected = await externalCoreText(root, 'zebra', {
      homeDir: dirs.home,
      customConfigDir: null,
    })
    expect(expected).toContain('decisions (project)')
    expect(fs.existsSync(path.join(path.dirname(root), 'node_modules'))).toBe(
      false,
    )

    const result = runBin(bin, ['zebra', '--kind', 'external'], {
      cwd: makeDir('claude-code-search-elsewhere-'),
      home: dirs.home,
    })
    // From another directory the bin finds no project at all.
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no project')

    const here = runBin(bin, ['zebra', '--kind', 'external', '--dir', root], {
      cwd: makeDir('claude-code-search-elsewhere-'),
      home: dirs.home,
    })
    expect(here.stderr).toBe('')
    expect(here.status).toBe(0)
    expect(here.stdout).toBe(`${expected}\n`)
  }, 60_000)

  it('started in a subfolder of a repository, reads the repo-root project file, its excludes and a user.local allow entry', async () => {
    const bin = await installBin()
    const root = makeProject()
    proposeDecisions(root)
    fs.writeFileSync(
      path.join(root, 'docs/decisions/log.md'),
      '---\ntitle: Decisions activity log\n---\n\nzebra activity\n',
    )
    fs.writeFileSync(
      path.join(root, '.systematic.jsonc'),
      `// repo-root project config\n${JSON.stringify({
        search: {
          sources: [
            {
              name: 'decisions',
              format: 'markdown',
              roots: ['docs/decisions'],
              exclude: ['log.md'],
            },
          ],
        },
      })}`,
    )
    const sub = path.join(root, 'packages/app')
    fs.mkdirSync(sub, { recursive: true })
    const dirs = makeUserDirs()
    // The allow entry lives only in the local overlay.
    allowProject(dirs.userConfigDir, root, 'systematic.local.json')
    expect(fs.existsSync(path.join(path.dirname(root), 'node_modules'))).toBe(
      false,
    )
    const expected = await externalCoreText(sub, 'zebra', {
      homeDir: dirs.home,
      customConfigDir: null,
    })

    const result = runBin(bin, ['zebra', '--kind', 'external'], {
      cwd: sub,
      home: dirs.home,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('decisions (project)')
    expect(result.stdout).toContain('decisions/zebra-rollback.md')
    expect(result.stdout).not.toContain('log.md')
    // The reply warns that the root file shadows the .opencode/ file (the
    // renderer cuts a long line, so only its start is stable); nothing else warns.
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(
      `project config (${path.join(root, '.systematic.jsonc')}) takes precedence over`,
    )
    expect(result.stdout).toBe(`${expected}\n`)
  }, 60_000)

  it('prints one stderr warning for a structurally broken project file, for external only', async () => {
    const bin = await installBin()
    const root = makeProject()
    fs.mkdirSync(path.join(root, '.opencode'))
    fs.writeFileSync(path.join(root, '.opencode/systematic.json'), '{ broken')
    const dirs = makeUserDirs()

    const external = runBin(bin, ['zebra', '--kind', 'external'], {
      cwd: root,
      home: dirs.home,
    })
    expect(external.status).toBe(0)
    expect(external.stderr).toBe(`${SEARCH_CLI_PROJECT_CONFIG_WARNING}\n`)
    expect(external.stdout).toContain('Project sources: the project config')

    const builtin = runBin(bin, ['zebra'], { cwd: root, home: dirs.home })
    expect(builtin.stderr).toBe('')
    expect(builtin.stdout).toBe(`${await coreText(root, 'zebra')}\n`)
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

/**
 * The bin's module graph holds the readers it needs and neither config
 * module. The metafile comes from the same build the bin ships, so this cannot
 * pass on a graph the bin does not use.
 */
describe('built systematic-search bin: module graph', () => {
  it('bundles the external readers and contains neither config.ts nor config-schema.ts', async () => {
    const { bundle, metafile } = await buildSearchBundle(ROOT_DIR)
    const modules = Object.keys(metafile.inputs).map((input) =>
      path.basename(input),
    )

    // Matching is the bundled matcher, never `path.matchesGlob` (Node 22+).
    expect(bundle.toString('utf8')).not.toContain('matchesGlob')
    for (const required of [
      'claude-code-search.ts',
      'search-cli.ts',
      'search-core.ts',
      'search-exclude.ts',
      'search-external.ts',
      'search-external-sources.ts',
      'search-project-identity.ts',
      'search-user-config.ts',
    ]) {
      expect(modules).toContain(required)
    }
    expect(modules).not.toContain('config.ts')
    expect(modules).not.toContain('config-schema.ts')
  }, 60_000)
})
