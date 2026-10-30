import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runSearchCli,
  SEARCH_CLI_DISABLED_NOTICE,
  type SearchCliSettingsLoad,
  type SearchCliSettingsLoader,
  searchCliUsage,
} from '../../src/lib/search-cli.js'
import {
  runSearch,
  SEARCH_ERRORS,
  SEARCH_NOTICES,
  type SearchSettings,
} from '../../src/lib/search-core.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

function makeProject(): string {
  const root = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-cli-'))),
  )
  fs.mkdirSync(path.join(root, '.git'))
  const dir = path.join(root, 'docs/solutions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'zebra-flake.md'),
    '---\ntitle: Zebra crossing flake\nsymptoms:\n  - zebra flake on retry\ntags:\n  - zebra\n---\n\nThe zebra flake appears when retries overlap.\n',
  )
  fs.writeFileSync(
    path.join(dir, 'retry-overlap.md'),
    '---\ntitle: Retry overlap\nmodule: retries\n---\n\nA second note that mentions the zebra once.\n',
  )
  fs.mkdirSync(path.join(root, 'packages/inner'), { recursive: true })
  return root
}

const USAGE_NAME = 'systematic search'

const CLEAN: SearchCliSettingsLoad = {
  settings: undefined,
  warnings: [],
  unreadable: false,
}

interface Run {
  readonly status: number
  readonly stdout: string[]
  readonly stderr: string[]
  readonly loadedWith: string[]
}

async function run(
  argv: string[],
  options: {
    readonly cwd: string
    readonly load?: SearchCliSettingsLoad | SearchCliSettingsLoader
    readonly usageName?: string
  },
): Promise<Run> {
  const stdout: string[] = []
  const stderr: string[] = []
  const loadedWith: string[] = []
  const load = options.load ?? CLEAN
  const status = await runSearchCli({
    argv,
    cwd: options.cwd,
    usageName: options.usageName ?? USAGE_NAME,
    loadSettings: (dir) => {
      loadedWith.push(dir)
      return typeof load === 'function' ? load(dir) : load
    },
    outputSink: (message) => stdout.push(message),
    errorSink: (message) => stderr.push(message),
  })
  return { status, stdout, stderr, loadedWith }
}

async function coreText(
  root: string,
  request: { query: unknown; kind?: unknown; limit?: unknown },
): Promise<string> {
  const response = await runSearch(request, { startDir: root })
  return response.text
}

describe('runSearchCli: results', () => {
  it('prints exactly the core text for a query and exits 0', async () => {
    const root = makeProject()
    const result = await run(['zebra', 'flake', 'retry'], { cwd: root })
    expect(result.status).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toEqual([
      await coreText(root, { query: 'zebra flake retry' }),
    ])
    expect(result.stdout[0]).toContain('docs/solutions/zebra-flake.md')
  })

  it('joins several words into one query', async () => {
    const root = makeProject()
    const joined = await run(['zebra', 'retry'], { cwd: root })
    expect(joined.stdout).toEqual([
      await coreText(root, { query: 'zebra retry' }),
    ])
  })

  it('passes --limit and --kind through, in spaced and = forms', async () => {
    const root = makeProject()
    const expected = await coreText(root, {
      query: 'zebra',
      kind: 'solution',
      limit: 1,
    })
    expect(expected).not.toContain('retry-overlap.md')
    for (const argv of [
      ['zebra', '--limit', '1', '--kind', 'solution'],
      ['--limit=1', '--kind=solution', 'zebra'],
      ['--kind', 'solution', 'zebra', '--limit', '1'],
    ]) {
      const result = await run(argv, { cwd: root })
      expect(result.status).toBe(0)
      expect(result.stdout).toEqual([expected])
    }
  })

  it('resolves --dir at a subdirectory up to the project root', async () => {
    const root = makeProject()
    const result = await run(
      ['zebra', '--dir', path.join(root, 'packages/inner')],
      {
        cwd: temp.track(fs.mkdtempSync(path.join(os.tmpdir(), 'search-cwd-'))),
      },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toEqual([await coreText(root, { query: 'zebra' })])
    expect(result.stdout[0]).toContain('zebra-flake.md')
  })

  it('resolves a relative --dir against cwd', async () => {
    const root = makeProject()
    const result = await run(['zebra', '--dir', 'packages/inner'], {
      cwd: root,
    })
    expect(result.stdout).toEqual([await coreText(root, { query: 'zebra' })])
    expect(result.loadedWith).toEqual([path.join(root, 'packages/inner')])
  })

  it('uses cwd when --dir is absent', async () => {
    const root = makeProject()
    const result = await run(['zebra'], { cwd: path.join(root, 'packages') })
    expect(result.stdout).toEqual([await coreText(root, { query: 'zebra' })])
    expect(result.loadedWith).toEqual([path.join(root, 'packages')])
  })

  it('ends flag parsing at --', async () => {
    const root = makeProject()
    const result = await run(['--limit', '1', '--', '--kind', 'zebra'], {
      cwd: root,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toEqual([
      await coreText(root, { query: '--kind zebra', limit: 1 }),
    ])
    const dash = await run(['--', '-zebra'], { cwd: root })
    expect(dash.stdout).toEqual([await coreText(root, { query: '-zebra' })])
  })

  it('treats a lone - as a query word', async () => {
    const root = makeProject()
    const result = await run(['zebra', '-'], { cwd: root })
    expect(result.status).toBe(0)
    expect(result.stdout).toEqual([await coreText(root, { query: 'zebra -' })])
  })

  it('exits 0 with the result for no hits and for no corpus', async () => {
    const root = makeProject()
    const noHits = await run(['qqqqqnotpresent'], { cwd: root })
    expect(noHits.status).toBe(0)
    expect(noHits.stdout[0]).toContain('0 hits')
    const bare = temp.track(
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-bare-'))),
    )
    fs.mkdirSync(path.join(bare, '.git'))
    const none = await run(['zebra'], { cwd: bare })
    expect(none.status).toBe(0)
    expect(none.stdout[0]).toContain('corpus: none')
  })

  it('prints the usage for --help and exits 0', async () => {
    const root = makeProject()
    for (const flag of ['--help', '-h']) {
      const result = await run([flag], { cwd: root })
      expect(result.status).toBe(0)
      expect(result.stdout).toEqual([searchCliUsage(USAGE_NAME)])
      expect(result.stderr).toEqual([])
      expect(result.loadedWith).toEqual([])
    }
  })
})

describe('searchCliUsage', () => {
  it('names the command it is given, and no other', () => {
    const usage = searchCliUsage('systematic-search')
    expect(usage.startsWith('Usage: systematic-search <query...>')).toBe(true)
    expect(usage).not.toContain('systematic search')
    expect(searchCliUsage('systematic search')).toContain(
      'Usage: systematic search <query...>',
    )
  })

  it('threads usageName into --help and into a usage error', async () => {
    const root = makeProject()
    const help = await run(['--help'], { cwd: root, usageName: 'my-bin' })
    expect(help.stdout).toEqual([searchCliUsage('my-bin')])
    const bad = await run(['zebra', '--bogus'], {
      cwd: root,
      usageName: 'my-bin',
    })
    expect(bad.status).toBe(2)
    expect(bad.stderr[0]).toContain('Usage: my-bin <query...>')
  })
})

describe('runSearchCli: usage errors', () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly argv: string[]
    readonly message: string
  }> = [
    { name: 'no query', argv: [], message: SEARCH_ERRORS.queryEmpty },
    {
      name: 'a blank query',
      argv: ['   '],
      message: SEARCH_ERRORS.queryEmpty,
    },
    {
      name: 'flags only',
      argv: ['--limit', '3'],
      message: SEARCH_ERRORS.queryEmpty,
    },
    {
      name: 'an unknown kind',
      argv: ['zebra', '--kind', 'bogus'],
      message: SEARCH_ERRORS.kindUnknown,
    },
    {
      name: 'a non-numeric limit',
      argv: ['zebra', '--limit', 'abc'],
      message: SEARCH_ERRORS.limitInvalid,
    },
    {
      name: 'limit 0',
      argv: ['zebra', '--limit', '0'],
      message: SEARCH_ERRORS.limitInvalid,
    },
    {
      name: 'limit 21',
      argv: ['zebra', '--limit', '21'],
      message: SEARCH_ERRORS.limitInvalid,
    },
    {
      name: 'a negative limit',
      argv: ['zebra', '--limit', '-1'],
      message: SEARCH_ERRORS.limitInvalid,
    },
    {
      name: 'a fractional limit',
      argv: ['zebra', '--limit=2.5'],
      message: SEARCH_ERRORS.limitInvalid,
    },
    {
      name: 'an exponent limit',
      argv: ['zebra', '--limit', '1e1'],
      message: SEARCH_ERRORS.limitInvalid,
    },
    {
      name: 'an over-long query',
      argv: ['x'.repeat(2001)],
      message: SEARCH_ERRORS.queryTooLong,
    },
  ]

  for (const entry of cases) {
    it(`exits 2 with the core's fixed message for ${entry.name}`, async () => {
      const root = makeProject()
      const result = await run(entry.argv, { cwd: root })
      expect(result.status).toBe(2)
      expect(result.stdout).toEqual([])
      expect(result.stderr).toEqual([entry.message])
    })
  }

  const parseCases: ReadonlyArray<{ name: string; argv: string[] }> = [
    { name: 'an unknown flag', argv: ['zebra', '--json'] },
    { name: 'an unknown short flag', argv: ['-x', 'zebra'] },
    { name: 'a --limit with no value', argv: ['zebra', '--limit'] },
    { name: 'a --dir with no value', argv: ['zebra', '--dir'] },
    { name: 'a --kind with no value', argv: ['zebra', '--kind'] },
    { name: 'a repeated flag', argv: ['zebra', '--limit', '1', '--limit=2'] },
  ]

  for (const entry of parseCases) {
    it(`exits 2 with the usage for ${entry.name}`, async () => {
      const root = makeProject()
      const result = await run(entry.argv, { cwd: root })
      expect(result.status).toBe(2)
      expect(result.stdout).toEqual([])
      expect(result.stderr).toHaveLength(1)
      expect(result.stderr[0]).toContain(searchCliUsage(USAGE_NAME))
      expect(result.stderr[0]).not.toContain('zebra')
      // Argument errors are decided before any settings load.
      expect(result.loadedWith).toEqual([])
    })
  }

  it('never echoes a rejected value or flag name', async () => {
    const root = makeProject()
    const evil = `\u001b[31mEVIL`
    for (const argv of [
      ['zebra', `--${evil}`],
      ['zebra', '--kind', evil],
      ['zebra', '--limit', evil],
    ]) {
      const result = await run(argv, { cwd: root })
      expect(result.status).toBe(2)
      expect(result.stderr.join('\n')).not.toContain('EVIL')
      expect(result.stderr.join('\n')).not.toContain('\u001b')
    }
  })
})

describe('runSearchCli: settings', () => {
  const disabledSettings: SearchSettings = { enabled: false }

  it('prints a disabled message and exits 0 when search is switched off', async () => {
    const root = makeProject()
    const result = await run(['zebra'], {
      cwd: root,
      load: { settings: disabledSettings, warnings: [], unreadable: false },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toEqual([SEARCH_CLI_DISABLED_NOTICE])
    expect(result.stdout[0]).toContain('disabled')
    expect(result.stdout[0]).not.toContain('zebra-flake')
    expect(result.stderr).toEqual([])
  })

  it('reports a malformed command line before it looks at the settings', async () => {
    const root = makeProject()
    const result = await run(['zebra', '--json'], {
      cwd: root,
      load: { settings: disabledSettings, warnings: [], unreadable: false },
    })
    expect(result.status).toBe(2)
    expect(result.stdout).toEqual([])
  })

  it('searches when enabled is true or unset', async () => {
    const root = makeProject()
    for (const settings of [{ enabled: true }, {}]) {
      const result = await run(['zebra'], {
        cwd: root,
        load: { settings, warnings: [], unreadable: false },
      })
      expect(result.status).toBe(0)
      expect(result.stdout[0]).toContain('zebra-flake.md')
    }
  })

  it('prints the loader warnings on stderr and keeps stdout to the result', async () => {
    const root = makeProject()
    const result = await run(['zebra'], {
      cwd: root,
      load: {
        settings: undefined,
        warnings: ['[systematic] one', '[systematic] two'],
        unreadable: false,
      },
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toEqual(['[systematic] one', '[systematic] two'])
    expect(result.stdout).toEqual([await coreText(root, { query: 'zebra' })])
  })

  it('prints the warnings even when search is switched off', async () => {
    const root = makeProject()
    const result = await run(['zebra'], {
      cwd: root,
      load: {
        settings: disabledSettings,
        warnings: ['[systematic] strip'],
        unreadable: false,
      },
    })
    expect(result.stderr).toEqual(['[systematic] strip'])
    expect(result.stdout).toEqual([SEARCH_CLI_DISABLED_NOTICE])
  })

  it('adds the config unreadable note and still returns results', async () => {
    const root = makeProject()
    const result = await run(['zebra'], {
      cwd: root,
      load: { settings: undefined, warnings: [], unreadable: true },
    })
    expect(result.status).toBe(0)
    expect(result.stdout[0]).toContain('Notes: config unreadable')
    expect(result.stdout[0]).toContain('zebra-flake.md')
    expect(result.stdout[0]).not.toContain('Lanes:')
  })

  it('treats a throwing loader as unreadable and still searches', async () => {
    const root = makeProject()
    const result = await run(['zebra'], {
      cwd: root,
      load: () => {
        throw new Error('secret-detail-from-loader')
      },
    })
    expect(result.status).toBe(0)
    expect(result.stdout[0]).toContain('Notes: config unreadable')
    expect(result.stdout[0]).toContain('zebra-flake.md')
    expect(result.stderr.join('\n')).not.toContain('secret-detail')
  })

  it('maps an unexpected failure to one fixed line and exit 1', async () => {
    const root = makeProject()
    const hostile = {
      get enabled(): boolean {
        throw new Error('secret-detail-from-host')
      },
    }
    const result = await run(['zebra'], {
      cwd: root,
      load: { settings: hostile, warnings: [], unreadable: false },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toEqual([SEARCH_NOTICES.failed])
  })
})
