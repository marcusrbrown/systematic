/**
 * Tests for scripts/generated-surfaces.ts (U4): the regen, drift and affected
 * commands.
 *
 * Every command runs against fake surface lists and a fake spawn that records
 * its calls, so no generator ever starts. `affected` runs in temp git repos.
 * The only real child processes are `node -e` probes for the real spawn and
 * the CLI file itself, run with a bad command. Nothing here writes a tracked
 * file, and a closing test asserts the repo status did not change.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  main,
  parseArgs,
  type RunnerContext,
  runAffected,
  runDrift,
  runRegen,
  type SpawnCommand,
  type SpawnResult,
  spawnCommand,
  USAGE,
} from '../../scripts/generated-surfaces.js'
import type { GeneratedSurface } from '../../scripts/lib/generated-surfaces.js'
import {
  cleanupTempDirs,
  commitFiles,
  createRepo,
  git,
  makeDir,
  ROOT_DIR,
} from './git-worktree-fixtures.js'

afterEach(() => {
  cleanupTempDirs()
})

const STATUS_AT_LOAD = spawnSync('git', ['status', '--porcelain'], {
  cwd: ROOT_DIR,
  encoding: 'utf8',
}).stdout

// ── Fakes ───────────────────────────────────────────────────────────────────

function fake(
  name: string,
  outputs: readonly string[] = [`gen/${name}.txt`],
  triggers: readonly string[] = [`src/${name}.ts`],
): GeneratedSurface {
  return {
    name,
    regenScript: `${name}:generate`,
    checkScript: `${name}:drift`,
    outputs,
    triggers,
  }
}

const SEVEN = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((name) =>
  fake(name),
)

interface Harness {
  readonly context: RunnerContext
  /** The script name of every spawned command, in order. */
  readonly scripts: string[]
  readonly argvs: (readonly string[])[]
  readonly cwds: string[]
  readonly out: string[]
  readonly err: string[]
}

/** Scripted results by script name; anything not listed exits 0 silently. */
function harness(
  rootDir: string,
  surfaces: readonly GeneratedSurface[],
  results: Record<string, SpawnResult> = {},
): Harness {
  const scripts: string[] = []
  const argvs: (readonly string[])[] = []
  const cwds: string[] = []
  const out: string[] = []
  const err: string[] = []
  const spawn: SpawnCommand = (argv, cwd) => {
    argvs.push(argv)
    cwds.push(cwd)
    const script = argv[2] ?? ''
    scripts.push(script)
    return Promise.resolve(results[script] ?? { exitCode: 0, output: '' })
  }
  return {
    context: {
      rootDir,
      surfaces,
      spawn,
      report: (text, stream) => {
        ;(stream === 'out' ? out : err).push(text)
      },
    },
    scripts,
    argvs,
    cwds,
    out,
    err,
  }
}

const fail = (output = 'boom\n', exitCode = 1): SpawnResult => ({
  exitCode,
  output,
})

/** A directory with the `node_modules` layout the preflight looks for. */
function installedDir(): string {
  const dir = makeDir('surfaces-runner-')
  installLayout(dir)
  return dir
}

function installLayout(dir: string) {
  for (const part of [
    'node_modules/.bin/biome',
    'node_modules/zod/package.json',
  ]) {
    const target = path.join(dir, part)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '')
  }
}

function write(work: string, rel: string, content: string) {
  const file = path.join(work, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const text = (lines: readonly string[]) => lines.join('\n')

// ── regen ───────────────────────────────────────────────────────────────────

describe('runRegen', () => {
  test('spawns each regeneration once, in list order, from the repo root', async () => {
    const root = installedDir()
    const h = harness(root, SEVEN)
    expect(await runRegen(h.context)).toBe(0)
    expect(h.scripts).toEqual(SEVEN.map((s) => s.regenScript))
    expect(
      h.argvs.every((argv) => argv[0] === 'bun' && argv[1] === 'run'),
    ).toBe(true)
    expect(h.cwds.every((cwd) => cwd === root)).toBe(true)
    expect(text(h.out)).toContain('regen: regenerated 7 surfaces')
    expect(h.err).toEqual([])
  })

  test('the third failure stops the run and names failed and not-run surfaces', async () => {
    const h = harness(installedDir(), SEVEN, {
      's3:generate': fail('s3 exploded\n'),
    })
    expect(await runRegen(h.context)).toBe(1)
    expect(h.scripts).toEqual(['s1:generate', 's2:generate', 's3:generate'])
    const err = text(h.err)
    expect(err).toContain('regen failed: s3')
    expect(err).toContain('s3 exploded')
    expect(err).toContain('already rewritten (s1, s2)')
    for (const name of ['s4', 's5', 's6', 's7']) {
      expect(err).toContain(name)
    }
    expect(err).toContain('not run:')
    expect(err).not.toMatch(/not run:[\s\S]*\bs1\b/)
    expect(text(h.out)).not.toContain('regenerated 7')
  })

  test('a first-surface failure says nothing was rewritten', async () => {
    const h = harness(installedDir(), SEVEN, { 's1:generate': fail() })
    expect(await runRegen(h.context)).toBe(1)
    expect(h.scripts).toEqual(['s1:generate'])
    expect(text(h.err)).toContain('no surface was rewritten')
  })

  test('a child killed by a signal counts as a failure', async () => {
    const h = harness(installedDir(), SEVEN, {
      's2:generate': { exitCode: null, output: '' },
    })
    expect(await runRegen(h.context)).toBe(1)
    expect(h.scripts).toEqual(['s1:generate', 's2:generate'])
  })

  test('the shrink-guard message is shown as the child printed it', async () => {
    const message =
      'refusing to write: output shrank from 40 to 3 entries (pass --allow-shrink to override)'
    const h = harness(installedDir(), SEVEN, {
      's2:generate': fail(`${message}\n`),
    })
    expect(await runRegen(h.context)).toBe(1)
    expect(text(h.err)).toContain(message)
  })

  test('no spawned command ever carries --allow-shrink', async () => {
    const root = installedDir()
    const regen = harness(root, SEVEN)
    await runRegen(regen.context)
    const drift = harness(root, SEVEN)
    await runDrift(drift.context)
    for (const argv of [...regen.argvs, ...drift.argvs]) {
      expect(argv.join(' ')).not.toContain('--allow-shrink')
    }
  })

  test('preflight failure prints "run bun install" and spawns nothing', async () => {
    const h = harness(makeDir('surfaces-bare-'), SEVEN)
    expect(await runRegen(h.context)).toBe(1)
    expect(h.scripts).toEqual([])
    expect(text(h.err)).toContain('run bun install')
  })
})

// ── drift ───────────────────────────────────────────────────────────────────

describe('runDrift', () => {
  test('AE1: two failures do not stop the run and each is reported by name', async () => {
    const h = harness(installedDir(), SEVEN, {
      's2:drift': fail('s2 is stale\n'),
      's5:drift': fail('s5 is stale\n'),
    })
    expect(await runDrift(h.context)).toBe(1)
    expect(h.scripts).toEqual(SEVEN.map((s) => s.checkScript))

    const lines = h.out
    const report = text(lines)
    for (const name of ['s1', 's3', 's4', 's6', 's7']) {
      expect(report).toContain(`[PASS] ${name}`)
      expect(report).not.toContain(`[FAIL] ${name}`)
    }
    for (const name of ['s2', 's5']) {
      expect(report).toContain(`[FAIL] ${name}`)
      expect(report).toContain(`${name} is stale`)
      expect(report).toContain(`fix: bun run ${name}:generate`)
    }
    expect(report.match(/\[FAIL\]/g)).toHaveLength(2)
    expect(report.match(/\[PASS\]/g)).toHaveLength(5)
    expect(lines.at(-1)).toBe('drift: 2 of 7 failed: s2, s5')
  })

  test('the report follows list order', async () => {
    const h = harness(installedDir(), SEVEN, { 's3:drift': fail() })
    await runDrift(h.context)
    const marks = h.out.slice(0, -1).map((entry) => entry.split('\n')[0])
    expect(marks).toEqual([
      '[PASS] s1',
      '[PASS] s2',
      '[FAIL] s3',
      '[PASS] s4',
      '[PASS] s5',
      '[PASS] s6',
      '[PASS] s7',
    ])
  })

  test('all checks passing exits 0 with an all-passed summary', async () => {
    const h = harness(installedDir(), SEVEN)
    expect(await runDrift(h.context)).toBe(0)
    expect(h.out.at(-1)).toBe('drift: all 7 surfaces passed')
    expect(text(h.out)).not.toContain('[FAIL]')
  })

  test('a failing child output is shown as the child printed it', async () => {
    const message = 'tests/fixtures drifted: 3 files differ'
    const h = harness(installedDir(), SEVEN, {
      's4:drift': fail(`${message}\n`),
    })
    await runDrift(h.context)
    expect(text(h.out)).toContain(message)
  })

  test('a check run uses check scripts only, never regeneration', async () => {
    const h = harness(installedDir(), SEVEN)
    await runDrift(h.context)
    expect(h.scripts.some((script) => script.endsWith(':generate'))).toBe(false)
  })

  test('preflight failure prints "run bun install" and spawns nothing', async () => {
    const h = harness(makeDir('surfaces-bare-'), SEVEN)
    expect(await runDrift(h.context)).toBe(1)
    expect(h.scripts).toEqual([])
    expect(text(h.err)).toContain('run bun install')
  })
})

// ── affected ────────────────────────────────────────────────────────────────

// a -> b: b reads what a writes. c is independent.
const CHAIN: readonly GeneratedSurface[] = [
  fake('a', ['gen/a.txt'], ['src/a.ts']),
  fake('b', ['gen/b.txt'], ['gen/a.txt']),
  fake('c', ['gen/c.txt'], ['src/c.ts']),
]

function chainRepo() {
  return createRepo({
    files: {
      '.gitignore': 'node_modules\n',
      'src/a.ts': 'a\n',
      'src/c.ts': 'c\n',
      'gen/a.txt': 'a\n',
      'gen/b.txt': 'b\n',
      'gen/c.txt': 'c\n',
    },
  })
}

describe('runAffected (list only)', () => {
  test('AE2: lists direct and downstream surfaces with regen commands, writes nothing', async () => {
    const repo = chainRepo()
    write(repo.work, 'src/a.ts', 'edited\n')
    const before = git(repo.work, ['status', '--porcelain'])
    const h = harness(repo.work, CHAIN)

    expect(await runAffected(h.context, { run: false })).toBe(0)

    const out = text(h.out)
    expect(out).toContain('[AFFECTED] a\n')
    expect(out).toContain('[AFFECTED] b (downstream)')
    expect(out).toContain('fix: bun run a:generate')
    expect(out).toContain('fix: bun run b:generate')
    expect(out).not.toContain('c:generate')
    expect(out).not.toContain('[AFFECTED] c')
    expect(h.scripts).toEqual([])
    expect(git(repo.work, ['status', '--porcelain'])).toBe(before)
  })

  test('lists surfaces in list order', async () => {
    const repo = chainRepo()
    write(repo.work, 'src/c.ts', 'edited\n')
    write(repo.work, 'src/a.ts', 'edited\n')
    const h = harness(repo.work, CHAIN)
    await runAffected(h.context, { run: false })
    const heads = h.out
      .filter((entry) => entry.startsWith('[AFFECTED]'))
      .map((entry) => entry.split('\n')[0])
    expect(heads).toEqual([
      '[AFFECTED] a',
      '[AFFECTED] b (downstream)',
      '[AFFECTED] c',
    ])
  })

  test('works without node_modules: no preflight', async () => {
    const repo = chainRepo()
    write(repo.work, 'src/a.ts', 'edited\n')
    const h = harness(repo.work, CHAIN)
    expect(fs.existsSync(path.join(repo.work, 'node_modules'))).toBe(false)
    expect(await runAffected(h.context, { run: false })).toBe(0)
    expect(text(h.err)).not.toContain('bun install')
  })

  test('AE5: no match prints the nothing-to-regenerate message and exits 0', async () => {
    const repo = chainRepo()
    write(repo.work, 'README.md', 'edited\n')
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: false })).toBe(0)
    expect(text(h.out)).toContain('nothing to regenerate')
    expect(h.scripts).toEqual([])
  })

  test('AE6: a missing origin/main exits non-zero, names the ref and spawns nothing', async () => {
    const repo = chainRepo()
    git(repo.work, ['update-ref', '-d', 'refs/remotes/origin/main'])
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: false })).toBe(1)
    expect(text(h.err)).toContain('origin/main')
    expect(h.out).toEqual([])
    expect(h.scripts).toEqual([])
  })

  test('a missing merge-base exits non-zero and names the ref', async () => {
    const repo = chainRepo()
    git(repo.work, ['checkout', '-q', '--orphan', 'unrelated'])
    commitFiles(repo.work, { 'island.txt': 'i\n' }, 'island')
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: false })).toBe(1)
    expect(text(h.err)).toContain('merge-base')
    expect(text(h.err)).toContain('origin/main')
  })
})

describe('runAffected --run', () => {
  function readyRepo() {
    const repo = chainRepo()
    installLayout(repo.work)
    return repo
  }

  test('AE4: regenerates the matched set plus closure in list order, then checks that set only', async () => {
    const repo = readyRepo()
    write(repo.work, 'src/a.ts', 'edited\n')
    const h = harness(repo.work, CHAIN)

    expect(await runAffected(h.context, { run: true })).toBe(0)

    expect(h.scripts).toEqual([
      'a:generate',
      'b:generate',
      'a:drift',
      'b:drift',
    ])
    expect(h.cwds.every((cwd) => cwd === repo.work)).toBe(true)
    expect(h.out.at(-1)).toBe('drift: all 2 surfaces passed')
  })

  test('a full match regenerates all, in list order, before any check', async () => {
    const repo = readyRepo()
    write(repo.work, 'src/c.ts', 'edited\n')
    write(repo.work, 'src/a.ts', 'edited\n')
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: true })).toBe(0)
    expect(h.scripts).toEqual([
      'a:generate',
      'b:generate',
      'c:generate',
      'a:drift',
      'b:drift',
      'c:drift',
    ])
  })

  test('stops at the first regeneration failure and runs no checks', async () => {
    const repo = readyRepo()
    write(repo.work, 'src/a.ts', 'edited\n')
    write(repo.work, 'src/c.ts', 'edited\n')
    const h = harness(repo.work, CHAIN, { 'b:generate': fail('b broke\n') })

    expect(await runAffected(h.context, { run: true })).toBe(1)

    expect(h.scripts).toEqual(['a:generate', 'b:generate'])
    const err = text(h.err)
    expect(err).toContain('regen failed: b')
    expect(err).toContain('b broke')
    expect(err).toContain('already rewritten (a)')
    expect(err).toMatch(/not run:\s+c/)
  })

  test('after a clean regeneration a failing check is reported like drift', async () => {
    const repo = readyRepo()
    write(repo.work, 'src/a.ts', 'edited\n')
    const h = harness(repo.work, CHAIN, { 'a:drift': fail('a still stale\n') })

    expect(await runAffected(h.context, { run: true })).toBe(1)

    const out = text(h.out)
    expect(out).toContain('[FAIL] a')
    expect(out).toContain('a still stale')
    expect(out).toContain('fix: bun run a:generate')
    expect(out).toContain('[PASS] b')
    expect(h.out.at(-1)).toBe('drift: 1 of 2 failed: a')
    // The check kept going past the failure.
    expect(h.scripts).toEqual([
      'a:generate',
      'b:generate',
      'a:drift',
      'b:drift',
    ])
  })

  test('AE5: nothing matched spawns nothing and exits 0', async () => {
    const repo = readyRepo()
    write(repo.work, 'README.md', 'edited\n')
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: true })).toBe(0)
    expect(text(h.out)).toContain('nothing to regenerate')
    expect(h.scripts).toEqual([])
  })

  test('AE6: a missing origin/main exits non-zero naming it, with nothing spawned', async () => {
    const repo = readyRepo()
    git(repo.work, ['update-ref', '-d', 'refs/remotes/origin/main'])
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: true })).toBe(1)
    expect(text(h.err)).toContain('origin/main')
    expect(h.scripts).toEqual([])
  })

  test('preflight failure prints "run bun install" and spawns nothing', async () => {
    const repo = chainRepo()
    write(repo.work, 'src/a.ts', 'edited\n')
    const h = harness(repo.work, CHAIN)
    expect(await runAffected(h.context, { run: true })).toBe(1)
    expect(text(h.err)).toContain('run bun install')
    expect(h.scripts).toEqual([])
  })
})

// ── CLI parsing and main ────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('recognises each command', () => {
    expect(parseArgs(['regen'])).toEqual({ kind: 'regen' })
    expect(parseArgs(['drift'])).toEqual({ kind: 'drift' })
    expect(parseArgs(['affected'])).toEqual({ kind: 'affected', run: false })
    expect(parseArgs(['affected', '--run'])).toEqual({
      kind: 'affected',
      run: true,
    })
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
  })

  test.each([
    [[]],
    [['bogus']],
    [['regen', '--allow-shrink']],
    [['regen', '--run']],
    [['drift', 'extra']],
    [['affected', '--allow-shrink']],
    [['affected', '--run', '--allow-shrink']],
    [['--run']],
  ])('%j is a usage error', (argv) => {
    expect(parseArgs(argv).kind).toBe('usage-error')
  })
})

describe('main', () => {
  test('a usage error prints usage on stderr, exits 2 and spawns nothing', async () => {
    for (const argv of [[], ['bogus'], ['regen', '--allow-shrink']]) {
      const h = harness(installedDir(), SEVEN)
      expect(await main(argv, h.context)).toBe(2)
      expect(text(h.err)).toContain(USAGE)
      expect(h.scripts).toEqual([])
    }
  })

  test('--help prints usage and exits 0', async () => {
    const h = harness(installedDir(), SEVEN)
    expect(await main(['--help'], h.context)).toBe(0)
    expect(text(h.out)).toContain('usage:')
  })

  test('dispatches regen and drift', async () => {
    const root = installedDir()
    const regen = harness(root, SEVEN)
    expect(await main(['regen'], regen.context)).toBe(0)
    expect(regen.scripts).toEqual(SEVEN.map((s) => s.regenScript))
    const drift = harness(root, SEVEN, { 's1:drift': fail() })
    expect(await main(['drift'], drift.context)).toBe(1)
  })

  test('dispatches affected and affected --run', async () => {
    const repo = chainRepo()
    installLayout(repo.work)
    write(repo.work, 'src/c.ts', 'edited\n')
    const list = harness(repo.work, CHAIN)
    expect(await main(['affected'], list.context)).toBe(0)
    expect(list.scripts).toEqual([])
    const run = harness(repo.work, CHAIN)
    expect(await main(['affected', '--run'], run.context)).toBe(0)
    expect(run.scripts).toEqual(['c:generate', 'c:drift'])
  })

  test('an environment failure outside a git repo is reported, not thrown', async () => {
    const h = harness(makeDir('surfaces-nogit-'), CHAIN)
    expect(await main(['affected'], h.context)).toBe(1)
    expect(text(h.err)).toContain('generated-surfaces:')
  })
})

// ── The real spawn and the real CLI file ────────────────────────────────────

describe('spawnCommand', () => {
  test('buffers stdout and stderr and reports the exit code', async () => {
    const result = await spawnCommand(
      [
        process.execPath,
        '-e',
        'console.log("to-out"); console.error("to-err"); process.exit(3)',
      ],
      ROOT_DIR,
    )
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('to-out')
    expect(result.output).toContain('to-err')
  })

  test('runs in the given cwd', async () => {
    const dir = makeDir('surfaces-cwd-')
    const result = await spawnCommand(
      [process.execPath, '-e', 'console.log(process.cwd())'],
      dir,
    )
    expect(result.exitCode).toBe(0)
    expect(fs.realpathSync(result.output.trim())).toBe(dir)
  })

  test('a command that cannot start fails instead of throwing', async () => {
    const result = await spawnCommand(
      ['definitely-not-a-real-command-xyz'],
      ROOT_DIR,
    )
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('failed to start')
  })
})

describe('the CLI file', () => {
  const cli = path.join(ROOT_DIR, 'scripts/generated-surfaces.ts')

  function runCli(args: readonly string[]) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    })
  }

  test('a bad command proves the import.meta.main wiring: usage and exit 2', () => {
    const result = runCli(['bogus'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown command: bogus')
    expect(result.stderr).toContain('usage:')
  })

  test('--allow-shrink is not passed through: it is a usage error', () => {
    const result = runCli(['regen', '--allow-shrink'])
    expect(result.status).toBe(2)
  })

  test('importing the module runs nothing: no output, exit 0', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', `await import(${JSON.stringify(cli)})`],
      { cwd: ROOT_DIR, encoding: 'utf8' },
    )
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  test('importing the module leaves the tracked tree as it was', () => {
    expect(
      spawnSync('git', ['status', '--porcelain'], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
      }).stdout,
    ).toBe(STATUS_AT_LOAD)
  })

  test('the file does not contain the quoted check-mode literal', () => {
    expect(fs.readFileSync(cli, 'utf8')).not.toContain(`'${'--check'}'`)
  })
})
