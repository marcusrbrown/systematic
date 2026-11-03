import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runSearchCli,
  SEARCH_CLI_DISABLED_NOTICE,
  SEARCH_CLI_PROJECT_CONFIG_WARNING,
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
import { EXTERNAL_REPLIES } from '../../src/lib/search-render.js'
import type { UserLevelConfigDirOptions } from '../../src/lib/search-user-config.js'
import {
  makeExternalEnv,
  userSource,
  writeMarkdown,
  writeUserSearch,
} from '../helpers/search-external-env.js'
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
    readonly configOptions?: UserLevelConfigDirOptions
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
    ...(options.configOptions !== undefined && {
      configOptions: options.configOptions,
    }),
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

describe('runSearchCli: kinds', () => {
  function addPlan(root: string): void {
    const dir = path.join(root, 'docs/plans')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'zebra-rollout.md'),
      '---\ntitle: Zebra rollout\nstatus: completed\n---\n\nRolling out the zebra change.\n',
    )
  }

  it('accepts --kind plan and --kind all, in both flag forms, and prints the core text', async () => {
    const root = makeProject()
    addPlan(root)
    for (const kind of ['plan', 'all']) {
      const expected = await coreText(root, { query: 'zebra', kind })
      for (const argv of [
        ['zebra', '--kind', kind],
        [`--kind=${kind}`, 'zebra'],
      ]) {
        const result = await run(argv, { cwd: root })
        expect(result.status).toBe(0)
        expect(result.stdout).toEqual([expected])
      }
    }
    const all = await run(['zebra', '--kind', 'all'], { cwd: root })
    expect(all.stdout[0]).toContain('docs/plans/zebra-rollout.md')
    expect(all.stdout[0]).toContain('docs/solutions/zebra-flake.md')
  })

  it('exits 2 with the fixed error for a wrong-case or padded all', async () => {
    const root = makeProject()
    for (const kind of ['ALL', 'all ', '']) {
      const result = await run(['zebra', '--kind', kind], { cwd: root })
      expect(result.status).toBe(2)
      expect(result.stderr).toEqual([SEARCH_ERRORS.kindUnknown])
    }
  })
})

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

  it('names every kind, all and the default in the usage text', () => {
    const usage = searchCliUsage('systematic-search')
    expect(usage).toContain(
      '[--kind solution|plan|brainstorm|ideation|all|external]',
    )
    for (const word of [
      'plan',
      'brainstorm',
      'ideation',
      'all',
      'external',
      'default',
    ]) {
      expect(usage).toContain(word)
    }
    expect(usage).not.toContain('Only "solution" exists')
  })

  it('says --limit applies to each source for --kind external, at most 5 per source', () => {
    for (const name of ['systematic-search', 'systematic search']) {
      const usage = searchCliUsage(name)
      const start = usage.indexOf('--limit <n>')
      expect(start).toBeGreaterThan(-1)
      const option = usage
        .slice(start)
        .split(/\n {2}-/)[0]
        ?.replace(/\s+/g, ' ')
      expect(option).toContain('1 to 20 (default: 8)')
      expect(option).toContain('--kind external')
      expect(option).toContain('each source')
      expect(option).toContain('at most 5 per source')
    }
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

describe('runSearchCli: kind external', () => {
  const ENABLED: SearchCliSettingsLoad = {
    settings: { enabled: true },
    warnings: [],
    unreadable: false,
  }
  const DISABLED: SearchCliSettingsLoad = {
    settings: { enabled: false },
    warnings: [],
    unreadable: false,
  }

  it('accepts --kind external in both flag forms and prints the core text', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    writeMarkdown(wiki, 'a.md', { title: 'Zebra decision', body: 'zebra' })
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
    const expected = (
      await runSearch(
        { query: 'zebra', kind: 'external' },
        { startDir: env.repo, configOptions: env.configOptions },
      )
    ).text
    expect(expected).toContain('wiki (user)')

    for (const argv of [
      ['zebra', '--kind', 'external'],
      ['--kind=external', 'zebra'],
    ]) {
      const result = await run(argv, {
        cwd: env.repo,
        configOptions: env.configOptions,
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toEqual([expected])
    }
  })

  it('hands its config-dir option to the external reader', async () => {
    const env = makeExternalEnv(temp)
    const wiki = path.join(env.root, 'wiki')
    writeMarkdown(wiki, 'a.md', { title: 'Zebra decision', body: 'zebra' })
    writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })

    const withDir = await run(['zebra', '--kind', 'external'], {
      cwd: env.repo,
      configOptions: env.configOptions,
    })
    const other = makeExternalEnv(temp)
    const withOther = await run(['zebra', '--kind', 'external'], {
      cwd: env.repo,
      configOptions: other.configOptions,
    })

    expect(withDir.stdout[0]).toContain('wiki (user)')
    expect(withOther.stdout[0]).toContain(EXTERNAL_REPLIES.noActiveSource)
  })

  describe('precedence, one case per step', () => {
    it('1. disabled wins over everything: the existing notice for an empty query', async () => {
      const bare = temp.track(
        fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-bare-'))),
      )
      const result = await run(['--kind', 'external'], {
        cwd: bare,
        load: DISABLED,
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toEqual([SEARCH_CLI_DISABLED_NOTICE])
    })

    it('2. with search enabled, no .git ancestor and an empty query, the core no-project reply wins', async () => {
      const env = makeExternalEnv(temp)
      const bare = temp.track(
        fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-bare-'))),
      )
      const result = await run(['--kind', 'external'], {
        cwd: bare,
        load: ENABLED,
        configOptions: env.configOptions,
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toEqual([])
      expect(result.stdout).toEqual([
        `External sources for "": ${EXTERNAL_REPLIES.noProject}`,
      ])
    })

    it('3. with a project and an empty query, the core validation error wins over any per-source state', async () => {
      const env = makeExternalEnv(temp)
      writeUserSearch(env, {
        sources: [userSource(env, 'gone', path.join(env.root, 'nope'))],
      })
      const result = await run(['--kind', 'external'], {
        cwd: env.repo,
        load: ENABLED,
        configOptions: env.configOptions,
      })
      expect(result.status).toBe(2)
      expect(result.stdout).toEqual([])
      expect(result.stderr).toEqual([SEARCH_ERRORS.queryEmpty])
    })

    it('4. with a project and a valid query, per-source states render', async () => {
      const env = makeExternalEnv(temp)
      writeUserSearch(env, {
        sources: [userSource(env, 'gone', path.join(env.root, 'nope'))],
      })
      const result = await run(['zebra', '--kind', 'external'], {
        cwd: env.repo,
        load: ENABLED,
        configOptions: env.configOptions,
      })
      expect(result.status).toBe(0)
      expect(result.stdout[0]).toContain('missing: root not found.')
    })
  })

  describe('a structurally broken project config', () => {
    function brokenProject() {
      const env = makeExternalEnv(temp)
      fs.mkdirSync(path.join(env.repo, '.opencode'))
      fs.writeFileSync(
        path.join(env.repo, '.opencode/systematic.json'),
        '{ "search": { "sources": "SECRET-VALUE" } }',
      )
      return env
    }

    it('prints one fixed stderr warning and the aggregate line in the reply, for external only', async () => {
      const env = brokenProject()
      const external = await run(['zebra', '--kind', 'external'], {
        cwd: env.repo,
        configOptions: env.configOptions,
      })
      expect(external.status).toBe(0)
      expect(external.stderr).toEqual([SEARCH_CLI_PROJECT_CONFIG_WARNING])
      expect(external.stdout[0]).toContain(
        'Project sources: the project config could not be read, so it proposes none.',
      )
      expect(external.stderr.join('\n')).not.toContain('SECRET-VALUE')

      const builtin = await run(['zebra'], {
        cwd: env.repo,
        configOptions: env.configOptions,
      })
      expect(builtin.stderr).toEqual([])
    })

    it('prints the stderr warning once even when a user source keeps the reply a sections reply', async () => {
      const env = brokenProject()
      const wiki = path.join(env.root, 'wiki')
      writeMarkdown(wiki, 'a.md', { title: 'Zebra decision', body: 'zebra' })
      writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })
      const result = await run(['zebra', '--kind', 'external'], {
        cwd: env.repo,
        configOptions: env.configOptions,
      })
      expect(result.stdout[0]).toContain('wiki (user)')
      expect(result.stderr).toEqual([SEARCH_CLI_PROJECT_CONFIG_WARNING])
    })
  })

  describe('a throwing settings loader', () => {
    it('reports config unreadable, runs the external call with the user sources it can read, and prints no fixed failure line', async () => {
      const env = makeExternalEnv(temp)
      const wiki = path.join(env.root, 'wiki')
      writeMarkdown(wiki, 'a.md', { title: 'Zebra decision', body: 'zebra' })
      writeUserSearch(env, { sources: [userSource(env, 'wiki', wiki)] })

      const result = await run(['zebra', '--kind', 'external'], {
        cwd: env.repo,
        configOptions: env.configOptions,
        load: () => {
          throw new Error('boom')
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toEqual([])
      expect(result.stdout[0]).toContain('Notes: config unreadable')
      expect(result.stdout[0]).toContain('wiki (user)')
      expect(result.stdout[0]).not.toContain(SEARCH_NOTICES.failed)
    })

    it('with nothing readable it returns no sources plus the note', async () => {
      const env = makeExternalEnv(temp)
      writeUserSearch(env, '{ broken')
      const result = await run(['zebra', '--kind', 'external'], {
        cwd: env.repo,
        configOptions: env.configOptions,
        load: () => {
          throw new Error('boom')
        },
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toEqual([])
      const lines = result.stdout[0]?.split('\n') ?? []
      expect(lines.slice(0, 3)).toEqual([
        `External sources for "zebra": ${EXTERNAL_REPLIES.noActiveSource}`,
        'Notes: config unreadable',
        'Warnings:',
      ])
      expect(lines[3]).toContain('could not be read')
    })
  })
})
