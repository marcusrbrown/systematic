import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCapabilitiesCli as runTestableCli } from '../../src/cli.js'
import type { ConfigObservationMetadata } from '../../src/lib/capability-snapshot.js'
import { MANIFEST_FILENAME } from '../../src/lib/pi-subagents-export.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.ts')

function mkTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-cli-test-'))
}

function snapshotTree(root: string): string {
  const entries: string[] = []

  function visit(directory: string, relative = ''): void {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))

    for (const child of children) {
      // Bun writes its own runtime module-resolution cache under a `.bun`
      // directory inside $HOME as a side effect of spawning the CLI
      // subprocess. That cache is Bun's own artifact, not something the
      // CLI under test writes, so it must not count as an unexpected file
      // when a fixture directory is used as HOME.
      if (child.name === '.bun') {
        continue
      }
      const childRelative = path.join(relative, child.name)
      const childPath = path.join(directory, child.name)
      if (child.isDirectory()) {
        entries.push(`${childRelative}/`)
        visit(childPath, childRelative)
      } else {
        entries.push(`${childRelative}:${fs.readFileSync(childPath, 'utf8')}`)
      }
    }
  }

  visit(root)
  return entries.join('\n')
}

function runCli(
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  }
}

const OBSERVED_AT = '2026-08-13T12:34:56.000Z'

type CapabilityCliRoots = Parameters<typeof runTestableCli>[0]['roots']

function makeCapabilityRoots(root: string): CapabilityCliRoots {
  const cwd = path.join(root, 'project')
  const homeDir = path.join(root, 'home')
  const packageRoot = path.join(root, 'package')
  const agentsRoot = path.join(packageRoot, 'agents')
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(agentsRoot, { recursive: true })
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/systematic', version: '9.8.7' }),
  )
  return { agentsRoot, cwd, homeDir, packageRoot }
}

function emptyConfig(): ConfigObservationMetadata {
  return {
    authorities: [],
    protectedFields: [],
    sources: [
      { kind: 'custom', presence: 'absent' },
      { kind: 'project', presence: 'absent' },
      { kind: 'user', presence: 'absent' },
    ],
  }
}

function runTestableCapabilities(
  roots: CapabilityCliRoots,
  args: string[] = ['capabilities'],
  config: ConfigObservationMetadata = emptyConfig(),
): { stdout: string; stderr: string; status: number } {
  const stdout: string[] = []
  const stderr: string[] = []
  const status = runTestableCli({
    argv: ['systematic', ...args],
    clock: () => Date.parse(OBSERVED_AT),
    config,
    errorSink: (message) => stderr.push(message),
    outputSink: (value) => stdout.push(value),
    roots,
  })
  return { status, stderr: stderr.join('\n'), stdout: stdout.join('\n') }
}

function runObservedCapabilities(
  roots: CapabilityCliRoots,
  config?: ConfigObservationMetadata,
): { status: number; stderr: string; stdout: string } {
  const stdout: string[] = []
  const stderr: string[] = []
  const status = runTestableCli({
    argv: ['systematic', 'capabilities'],
    clock: () => Date.parse(OBSERVED_AT),
    errorSink: (message) => stderr.push(message),
    outputSink: (value) => stdout.push(value),
    roots,
    ...(config === undefined ? {} : { config }),
  })
  return { status, stderr: stderr.join('\n'), stdout: stdout.join('\n') }
}

describe('cli setup --harness', () => {
  it('help text documents both harness values', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['--help'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('setup --harness')
      expect(result.stdout).toContain('opencode|pi')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('happy path: setup --harness opencode configures project-local plugin', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'opencode'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('opencode.jsonc')
      expect(result.stdout).toMatch(/configured/i)

      const written = JSON.parse(
        fs.readFileSync(path.join(cwd, 'opencode.jsonc'), 'utf8'),
      ) as { plugin?: unknown[] }
      expect(written.plugin).toEqual(['@fro.bot/systematic'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('happy path: setup --harness pi configures .pi/settings.json', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'pi'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('.pi/settings.json')

      const written = JSON.parse(
        fs.readFileSync(path.join(cwd, '.pi/settings.json'), 'utf8'),
      ) as { packages?: unknown[] }
      expect(written.packages).toEqual(['npm:@fro.bot/systematic'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('idempotent: rerunning setup --harness pi reports already configured, no dup writes', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['setup', '--harness', 'pi'], cwd)
      const second = runCli(['setup', '--harness', 'pi'], cwd)
      expect(second.exitCode).toBe(0)
      expect(second.stdout).toMatch(/already configured/i)

      const written = JSON.parse(
        fs.readFileSync(path.join(cwd, '.pi/settings.json'), 'utf8'),
      ) as { packages?: unknown[] }
      expect(written.packages).toEqual(['npm:@fro.bot/systematic'])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('coexistence: .opencode/opencode.jsonc wins over a root opencode.json', () => {
    const cwd = mkTempCwd()
    try {
      fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
      fs.mkdirSync(path.join(cwd, '.opencode'))
      fs.writeFileSync(
        path.join(cwd, '.opencode/opencode.jsonc'),
        '{ "plugin": [] }',
      )
      const result = runCli(['setup', '--harness', 'opencode'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        path.join(cwd, '.opencode/opencode.jsonc'),
      )
      expect(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).toBe(
        '{}',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('isolation: setup --harness pi never writes opencode config', () => {
    const cwd = mkTempCwd()
    try {
      fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
      runCli(['setup', '--harness', 'pi'], cwd)
      expect(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).toBe(
        '{}',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('missing --harness value fails clearly with nonzero exit and no writes', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('unknown --harness value fails clearly with nonzero exit, no writes, and stderr (not stdout) usage', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'bogus'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
      expect(result.stderr).toContain('Available: opencode, pi')
      expect(result.stdout).not.toContain('Available: opencode, pi')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('extra positional args after harness value fail clearly with nonzero exit and no writes', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(
        ['setup', '--harness', 'opencode', 'extra-arg'],
        cwd,
      )
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('missing --harness flag entirely fails clearly with nonzero exit and no writes', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('no --global flag exists (rejected as unknown extra arg)', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'opencode', '--global'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('cli capabilities', () => {
  it('emits a read-only versioned JSON diagnostic without writing to cwd', () => {
    const cwd = mkTempCwd()
    try {
      const before = fs.readdirSync(cwd)
      const result = runCli(['capabilities'], cwd)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const parsed = JSON.parse(result.stdout) as {
        command?: string
        schemaVersion?: string
        identity?: { argv?: { subcommand?: string } }
      }
      expect(parsed.command).toBe('systematic capabilities')
      expect(parsed.schemaVersion).toBe('cli-capabilities.v1')
      expect(parsed.identity?.argv?.subcommand).toBe('capabilities')
      expect(JSON.stringify(parsed)).not.toContain(cwd)
      expect(fs.readdirSync(cwd)).toEqual(before)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('documents read-only standalone observation and non-runtime scope in help', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['--help'], cwd)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/capabilities.*read-only/i)
      expect(result.stdout).toMatch(/standalone-cli/i)
      expect(result.stdout).toMatch(/host-runtime|canonical-registry/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports invalid capabilities invocation through stderr', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['capabilities', '--unexpected'], cwd)

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/usage:.*capabilities/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not mutate the full diagnostic fixture tree or create generated artifacts', () => {
    const root = mkTempCwd()
    try {
      const roots = makeCapabilityRoots(root)
      fs.writeFileSync(path.join(roots.cwd, 'fixture-secret.json'), 'secret')
      const before = snapshotTree(root)

      const result = runTestableCapabilities(roots)

      expect(result.status).toBe(0)
      expect(snapshotTree(root)).toBe(before)
      expect(result.stdout).not.toContain('fixture-secret')
      expect(result.stdout).not.toContain(MANIFEST_FILENAME)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps setup/export/provider operations outside the capability path', () => {
    const source = fs.readFileSync(CLI_PATH, 'utf8')
    const start = source.indexOf('function runCapabilities')
    const end = source.indexOf('function isHarness', start)
    const capabilityPath = source.slice(start, end)

    expect(capabilityPath).not.toMatch(/setupHarness|exportPersonas|refresh\(/)
    expect(capabilityPath).not.toMatch(/provider|generated|manifest/i)
  })
})

describe('testable capabilities entrypoint', () => {
  it('is deterministic, bounded, and read-only for frozen roots and clock', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-capabilities-'),
    )
    try {
      const roots = makeCapabilityRoots(root)
      const before = fs.readdirSync(root)
      const first = runTestableCapabilities(roots)
      const second = runTestableCapabilities(roots)

      expect(first.status).toBe(0)
      expect(first.stderr).toBe('')
      expect(first.stdout).toBe(second.stdout)
      const parsed = JSON.parse(first.stdout) as {
        facts: Array<Record<string, unknown>>
        identity: { package: { name: string; version: string } }
      }
      expect(parsed.identity.package).toEqual({
        name: '@fixture/systematic',
        version: '9.8.7',
      })
      expect(parsed.facts).toContainEqual({
        factId: 'host-runtime',
        kind: 'status',
        limitationCode: 'host-runtime-unobservable',
        status: 'unknown',
      })
      expect(first.stdout).not.toContain(root)
      expect(fs.readdirSync(root)).toEqual(before)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('summarizes only winning skill entries and roots', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-capabilities-'),
    )
    try {
      const roots = makeCapabilityRoots(root)
      const winnerDir = path.join(roots.cwd, '.opencode/skills/dupe')
      const loserDir = path.join(roots.homeDir, '.claude/skills/dupe')
      fs.mkdirSync(winnerDir, { recursive: true })
      fs.mkdirSync(loserDir, { recursive: true })
      fs.writeFileSync(
        path.join(winnerDir, 'SKILL.md'),
        '---\nname: dupe\ndescription: winner\n---\nWinner body',
      )
      fs.writeFileSync(
        path.join(loserDir, 'SKILL.md'),
        '---\nname: dupe\ndescription: loser-secret\n---\nLoser secret body',
      )

      const result = runTestableCapabilities(roots)
      const parsed = JSON.parse(result.stdout) as {
        facts: Array<Record<string, unknown>>
      }
      expect(parsed.facts).toContainEqual({
        count: 1,
        discoveryId: 'skills',
        factId: 'discovery-summary',
        kind: 'discovery',
        sourceId: 'discovery:skills',
        status: 'available',
        winningRoots: ['project-opencode'],
      })
      expect(result.stdout).not.toContain('loser-secret')
      expect(result.stdout).not.toContain('Loser secret body')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('suppresses the agent summary on duplicate flat names', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-capabilities-'),
    )
    try {
      const roots = makeCapabilityRoots(root)
      for (const category of ['research', 'review']) {
        const dir = path.join(roots.agentsRoot, category)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'duplicate.md'),
          `---\nname: duplicate\ndescription: ${category}\n---\n${category} body`,
        )
      }

      const result = runTestableCapabilities(roots)
      const parsed = JSON.parse(result.stdout) as {
        facts: Array<Record<string, unknown>>
      }
      const agentFacts = parsed.facts.filter(
        (fact) => fact.sourceId === 'discovery:agents',
      )
      expect(agentFacts).toEqual([
        {
          errorCode: 'structural-invalid',
          factId: 'discovery-summary',
          kind: 'status',
          sourceId: 'discovery:agents',
          status: 'unavailable',
        },
      ])
      expect(JSON.stringify(agentFacts)).not.toContain('count')
      expect(result.stdout).not.toContain(roots.agentsRoot)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports malformed skill and agent sources without leaking content or paths', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-capabilities-'),
    )
    try {
      const roots = makeCapabilityRoots(root)
      const brokenSkill = path.join(
        roots.cwd,
        '.opencode/skills/broken/SKILL.md',
      )
      fs.mkdirSync(brokenSkill, { recursive: true })
      const brokenAgent = path.join(roots.agentsRoot, 'broken.md')
      fs.writeFileSync(
        brokenAgent,
        '---\nname: broken\ndescription: secret-agent-description\n---\nAgent body',
      )
      fs.writeFileSync(
        brokenAgent,
        '---\nname: [broken\n---\nsecret-agent-body',
      )

      const result = runTestableCapabilities(roots)
      const parsed = JSON.parse(result.stdout) as {
        facts: Array<Record<string, unknown>>
      }
      expect(parsed.facts).toContainEqual({
        errorCode: 'source-read-failed',
        factId: 'discovery-source-issue',
        kind: 'status',
        sourceId: 'discovery:skills',
        status: 'unavailable',
      })
      expect(parsed.facts).toContainEqual({
        count: 0,
        discoveryId: 'skills',
        factId: 'discovery-summary',
        kind: 'discovery',
        sourceId: 'discovery:skills',
        status: 'available',
        winningRoots: [],
      })
      expect(parsed.facts).toContainEqual({
        errorCode: 'structural-invalid',
        factId: 'discovery-summary',
        kind: 'status',
        sourceId: 'discovery:agents',
        status: 'unavailable',
      })
      expect(result.stdout).not.toContain(root)
      expect(result.stdout).not.toContain('secret-agent')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns bounded stderr and nonzero status for invalid invocation', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-capabilities-'),
    )
    try {
      const roots = makeCapabilityRoots(root)
      const result = runTestableCapabilities(roots, [
        'capabilities',
        '--unexpected',
      ])

      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Usage: systematic capabilities')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// CLI: config show (Unit 6, plan 2026-09-04-002-feat-model-config-profiles)
// ---------------------------------------------------------------------------

describe('cli config show', () => {
  function writeProjectConfig(
    project: string,
    value: Record<string, unknown>,
  ): void {
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true })
    fs.writeFileSync(
      path.join(project, '.opencode/systematic.json'),
      JSON.stringify(value),
    )
  }

  function writeUserConfig(home: string, value: Record<string, unknown>): void {
    const userConfigDir = path.join(home, '.config/opencode')
    fs.mkdirSync(userConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(userConfigDir, 'systematic.json'),
      JSON.stringify(value),
    )
  }

  it('a selected profile prints its name and selecting source', () => {
    const root = mkTempCwd()
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    try {
      fs.mkdirSync(project, { recursive: true })
      writeUserConfig(home, {
        profile: 'fast',
        profiles: {
          fast: {
            agents: { 'correctness-reviewer': { model: 'anthropic/haiku' } },
          },
        },
      })

      const result = runCli(['config', 'show'], project, { HOME: home })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Active profile: fast')
      expect(result.stdout).toContain('Selected by:    user')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('a missing profile name prints the fallback that occurred', () => {
    const root = mkTempCwd()
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    try {
      fs.mkdirSync(project, { recursive: true })
      writeUserConfig(home, {
        profile: 'fast',
        profiles: {
          fast: {
            agents: { 'correctness-reviewer': { model: 'anthropic/haiku' } },
          },
        },
      })
      writeProjectConfig(project, { profile: 'missing-name' })

      const result = runCli(['config', 'show'], project, { HOME: home })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        'Fallback:       requested "missing-name" is not defined; used your default profile "fast"',
      )
      expect(result.stdout).toContain('Active profile: fast')
      expect(result.stdout).toContain('Selected by:    project')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('the routing table lists each overlaid agent with model, qualifier, and source per harness', () => {
    const root = mkTempCwd()
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    try {
      fs.mkdirSync(project, { recursive: true })
      writeUserConfig(home, {
        agents: {
          'correctness-reviewer': {
            model: 'anthropic/base-model',
            opencode: { variant: 'v2' },
            pi: { thinking: 'high' },
          },
        },
      })

      const result = runCli(['config', 'show'], project, { HOME: home })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('correctness-reviewer (review):')
      expect(result.stdout).toContain(
        'opencode: model=anthropic/base-model (agent/flat), variant=v2 (agent/block)',
      )
      expect(result.stdout).toContain(
        'pi: model=anthropic/base-model (agent/flat), thinking=high (agent/block)',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prints one line when no profiles and no overlays are defined', () => {
    const root = mkTempCwd()
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    try {
      fs.mkdirSync(project, { recursive: true })
      fs.mkdirSync(home, { recursive: true })

      const result = runCli(['config', 'show'], project, { HOME: home })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        'No profiles are selected and no per-agent/category overlays are defined.',
      )
      expect(result.stdout).not.toContain('Active profile:')
      expect(result.stdout).not.toContain('Routing:')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaks no env value and no custom-config comment text', () => {
    const root = mkTempCwd()
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    const custom = path.join(root, 'custom')
    const envCanary = 'ENV-CANARY-DO-NOT-LEAK-8f2a'
    const commentCanary = 'COMMENT-CANARY-DO-NOT-LEAK-c91e'
    try {
      fs.mkdirSync(project, { recursive: true })
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(custom, { recursive: true })
      // The comment canary lives in the CUSTOM config (OPENCODE_CONFIG_DIR),
      // whose raw contents `config show` has never printed (only user and
      // project files are dumped) -- proving the new Resolved section
      // doesn't echo raw source text (comments are stripped by the JSONC
      // parser) or reach into files it isn't supposed to display at all.
      fs.writeFileSync(
        path.join(custom, 'systematic.json'),
        `{\n  // ${commentCanary}\n  "agents": { "correctness-reviewer": { "model": "anthropic/custom-model" } }\n}`,
      )

      const result = runCli(['config', 'show'], project, {
        HOME: home,
        OPENCODE_CONFIG_DIR: custom,
        MY_SECRET_TOKEN: envCanary,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(envCanary)
      expect(result.stdout).not.toContain(commentCanary)
      expect(result.stdout).not.toContain(custom)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  describe('--json', () => {
    // Both the prose routing table and the --json routing array must
    // exclude a disabled agent.
    it('a disabled agent is excluded from the --json routing array', () => {
      const root = mkTempCwd()
      const home = path.join(root, 'home')
      const project = path.join(root, 'project')
      try {
        fs.mkdirSync(project, { recursive: true })
        writeUserConfig(home, {
          disabled_agents: ['correctness-reviewer'],
          categories: { review: { model: 'anthropic/haiku' } },
        })

        const result = runCli(['config', 'show', '--json'], project, {
          HOME: home,
        })

        expect(result.exitCode).toBe(0)
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>
        const routing = parsed.routing as Array<Record<string, unknown>>
        const disabledEntry = routing.find(
          (r) =>
            (r.target as Record<string, unknown>).agentKey ===
            'correctness-reviewer',
        )
        expect(disabledEntry).toBeUndefined()
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('parses as JSON and has the documented top-level keys', () => {
      const root = mkTempCwd()
      const home = path.join(root, 'home')
      const project = path.join(root, 'project')
      try {
        fs.mkdirSync(project, { recursive: true })
        writeUserConfig(home, {
          profile: 'fast',
          profiles: {
            fast: {
              agents: { 'correctness-reviewer': { model: 'anthropic/haiku' } },
            },
          },
        })

        const result = runCli(['config', 'show', '--json'], project, {
          HOME: home,
        })

        expect(result.exitCode).toBe(0)
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>
        expect(Object.keys(parsed).sort()).toEqual([
          'activeProfile',
          'locations',
          'profileFallback',
          'profileSelectorSource',
          'routing',
        ])
        expect(parsed.activeProfile).toBe('fast')
        expect(parsed.profileSelectorSource).toBe('user')
        expect(parsed.profileFallback).toBeNull()
        const locations = parsed.locations as Record<string, unknown>
        expect(Object.keys(locations).sort()).toEqual([
          'custom',
          'project',
          'user',
        ])
        expect(typeof locations.user).toBe('string')
        expect(typeof locations.project).toBe('string')
        expect(locations.custom).toBeNull()
        const routing = parsed.routing as Array<Record<string, unknown>>
        expect(routing.length).toBeGreaterThan(0)
        const entry = routing.find(
          (r) =>
            (r.target as Record<string, unknown>).agentKey ===
            'correctness-reviewer',
        )
        expect(entry).toBeDefined()
        expect(Object.keys(entry as object).sort()).toEqual([
          'opencode',
          'pi',
          'target',
        ])
        const opencode = (entry as Record<string, unknown>).opencode as Record<
          string,
          unknown
        >
        // 'qualifier' is undefined (unset) for this fixture, so
        // JSON.stringify legitimately omits the key -- only 'model' and
        // 'source' are guaranteed present here.
        for (const key of Object.keys(opencode)) {
          expect(['model', 'qualifier', 'source']).toContain(key)
        }
        expect(opencode.model).toBe('anthropic/haiku')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('contains no raw config contents (comment canary absent)', () => {
      const root = mkTempCwd()
      const home = path.join(root, 'home')
      const project = path.join(root, 'project')
      const commentCanary = 'JSON-MODE-CANARY-DO-NOT-LEAK-4b7e'
      try {
        fs.mkdirSync(project, { recursive: true })
        fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true })
        fs.writeFileSync(
          path.join(home, '.config/opencode/systematic.jsonc'),
          `{\n  // ${commentCanary}\n  "agents": { "correctness-reviewer": { "model": "anthropic/haiku" } }\n}`,
        )

        const result = runCli(['config', 'show', '--json'], project, {
          HOME: home,
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).not.toContain(commentCanary)
        expect(result.stdout).not.toContain('//')
        expect(() => JSON.parse(result.stdout)).not.toThrow()
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>
        const routing = parsed.routing as Array<Record<string, unknown>>
        const entry = routing.find(
          (r) =>
            (r.target as Record<string, unknown>).agentKey ===
            'correctness-reviewer',
        )
        expect(
          (
            (entry as Record<string, unknown>).opencode as Record<
              string,
              unknown
            >
          ).model,
        ).toBe('anthropic/haiku')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('prose mode is unchanged when --json is omitted', () => {
      const root = mkTempCwd()
      const home = path.join(root, 'home')
      const project = path.join(root, 'project')
      try {
        fs.mkdirSync(project, { recursive: true })
        writeUserConfig(home, {
          profile: 'fast',
          profiles: {
            fast: {
              agents: { 'correctness-reviewer': { model: 'anthropic/haiku' } },
            },
          },
        })

        const result = runCli(['config', 'show'], project, { HOME: home })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('Configuration locations:')
        expect(result.stdout).toContain('Active profile: fast')
        expect(() => JSON.parse(result.stdout)).toThrow()
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('an unknown flag is rejected with a nonzero exit and usage text', () => {
      const root = mkTempCwd()
      try {
        fs.mkdirSync(root, { recursive: true })
        const result = runCli(['config', 'show', '--bogus'], root)

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain('Unknown argument')
        expect(result.stderr).toContain('--json')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    // A load failure must be reported as `{ error }` with a nonzero exit,
    // not silently degrade to a success-shaped `{ routing: [] }` with no
    // indication anything failed.
    it('a config load failure is reported as { error } with a nonzero exit', () => {
      const root = mkTempCwd()
      const home = path.join(root, 'home')
      const project = path.join(root, 'project')
      try {
        fs.mkdirSync(project, { recursive: true })
        // A variant with no model anywhere is a config-load error (R3b).
        writeUserConfig(home, {
          agents: { 'correctness-reviewer': { variant: 'high' } },
        })

        const result = runCli(['config', 'show', '--json'], project, {
          HOME: home,
        })

        expect(result.exitCode).not.toBe(0)
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>
        expect(typeof parsed.error).toBe('string')
        expect(parsed.error as string).toContain('correctness-reviewer')
        expect(parsed.routing).toBeUndefined()
        expect(parsed.activeProfile).toBeUndefined()
        const locations = parsed.locations as Record<string, unknown>
        expect(typeof locations.user).toBe('string')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// CLI: pi-subagents command
// ---------------------------------------------------------------------------

describe('cli pi-subagents', () => {
  it('pi-subagents with no subcommand prints usage and exits nonzero', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents'], cwd)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(
        /usage|subcommand|preview|export|refresh|cleanup/i,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('pi-subagents with unknown subcommand exits nonzero', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'bogus'], cwd)
      expect(result.exitCode).not.toBe(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('backward compat: existing setup --harness pi still works', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['setup', '--harness', 'pi'], cwd)
      expect(result.exitCode).toBe(0)
      expect(fs.existsSync(path.join(cwd, '.pi', 'settings.json'))).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preview: exits 0 and writes nothing', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'preview'], cwd)
      expect(result.exitCode).toBe(0)
      // No .pi/agents directory created
      expect(fs.existsSync(path.join(cwd, '.pi', 'agents'))).toBe(false)
      // Output mentions the target path and some action words
      expect(result.stdout).toMatch(/\.pi[/\\]agents/i)
      expect(result.stdout).toMatch(/create|update|refuse/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preview --scope global: exits 0 and writes nothing, shows global path', () => {
    const cwd = mkTempCwd()
    const fakeGlobal = mkTempCwd()
    try {
      const result = runCli(
        ['pi-subagents', 'preview', '--scope', 'global'],
        cwd,
        { PI_CODING_AGENT_DIR: fakeGlobal },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(fakeGlobal)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(fakeGlobal, { recursive: true, force: true })
    }
  })

  it('export: writes persona files under .pi/agents/', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'export'], cwd)
      expect(result.exitCode).toBe(0)

      const agentsDir = path.join(cwd, '.pi', 'agents')
      expect(fs.existsSync(agentsDir)).toBe(true)

      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) {
        expect(f).toMatch(/^systematic-[a-z0-9-]+\.md$/)
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('export: prints per-file preview action lines before the mutation summary', () => {
    const cwd = mkTempCwd()
    try {
      const result = runCli(['pi-subagents', 'export'], cwd)
      expect(result.exitCode).toBe(0)

      const targetIdx = result.stdout.indexOf('Target:')
      const createIdx = result.stdout.indexOf('(create)')
      const summaryIdx = result.stdout.indexOf('Summary:')
      const exportedIdx = result.stdout.indexOf('Exported')

      // Preview renders per-file action lines (e.g. "+ foo.md  (create)")
      expect(createIdx).toBeGreaterThan(-1)
      // Preview renders a Summary line before the export mutates anything
      expect(summaryIdx).toBeGreaterThan(-1)
      // Ordering: target, then action lines, then summary, then mutation result
      expect(targetIdx).toBeGreaterThan(-1)
      expect(createIdx).toBeGreaterThan(targetIdx)
      expect(summaryIdx).toBeGreaterThan(createIdx)
      expect(exportedIdx).toBeGreaterThan(summaryIdx)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('export idempotent: second run reports no changes', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      const result2 = runCli(['pi-subagents', 'export'], cwd)
      expect(result2.exitCode).toBe(0)
      expect(result2.stdout).toMatch(/no changes|up.to.date|already/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('export refuses to overwrite pre-existing unowned file', () => {
    const cwd = mkTempCwd()
    try {
      const agentsDir = path.join(cwd, '.pi', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(
        path.join(agentsDir, 'systematic-adversarial-reviewer.md'),
        'user content',
      )

      runCli(['pi-subagents', 'export'], cwd)
      // Export with pre-existing unowned file: either nonzero or ok with warning
      // Either way, the user file must be untouched
      expect(
        fs.readFileSync(
          path.join(agentsDir, 'systematic-adversarial-reviewer.md'),
          'utf-8',
        ),
      ).toBe('user content')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refresh: reports drift after manual file edit', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      const agentsDir = path.join(cwd, '.pi', 'agents')
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      const first = files[0]
      expect(first).toBeDefined()
      if (!first) return
      const filePath = path.join(agentsDir, first)
      const original = fs.readFileSync(filePath, 'utf-8')
      fs.appendFileSync(filePath, '\n<!-- drift -->')

      const result = runCli(['pi-subagents', 'refresh'], cwd)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/updated|refresh|restored/i)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('cleanup: removes all generated files and manifest, leaves user files', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      const agentsDir = path.join(cwd, '.pi', 'agents')
      // Plant a user file
      fs.writeFileSync(path.join(agentsDir, 'my-agent.md'), 'user')

      const result = runCli(['pi-subagents', 'cleanup'], cwd)
      expect(result.exitCode).toBe(0)

      // All systematic-*.md gone
      const remaining = fs
        .readdirSync(agentsDir)
        .filter((f) => f !== 'my-agent.md')
      expect(remaining).toHaveLength(0)
      // User file survives
      expect(
        fs.readFileSync(path.join(agentsDir, 'my-agent.md'), 'utf-8'),
      ).toBe('user')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('default scope is project when --scope omitted', () => {
    const cwd = mkTempCwd()
    try {
      runCli(['pi-subagents', 'export'], cwd)
      expect(fs.existsSync(path.join(cwd, '.pi', 'agents'))).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('--scope global writes to PI_CODING_AGENT_DIR/agents', () => {
    const cwd = mkTempCwd()
    const globalBase = mkTempCwd()
    try {
      const result = runCli(
        ['pi-subagents', 'export', '--scope', 'global'],
        cwd,
        { PI_CODING_AGENT_DIR: globalBase },
      )
      expect(result.exitCode).toBe(0)
      const agentsDir = path.join(globalBase, 'agents')
      expect(fs.existsSync(agentsDir)).toBe(true)
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      expect(files.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(globalBase, { recursive: true, force: true })
    }
  })

  it('export applies trusted custom-config-dir model overlay to matching exported persona', () => {
    const cwd = mkTempCwd()
    const customConfigDir = mkTempCwd()
    try {
      fs.writeFileSync(
        path.join(customConfigDir, 'systematic.json'),
        JSON.stringify({
          agents: { 'repo-research-analyst': { model: 'openai/gpt-5' } },
        }),
      )

      const result = runCli(['pi-subagents', 'export'], cwd, {
        OPENCODE_CONFIG_DIR: customConfigDir,
      })
      expect(result.exitCode).toBe(0)

      const target = path.join(
        cwd,
        '.pi',
        'agents',
        'systematic-repo-research-analyst.md',
      )
      expect(fs.existsSync(target)).toBe(true)
      expect(fs.readFileSync(target, 'utf-8')).toMatch(
        /^model: "openai\/gpt-5"$/m,
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(customConfigDir, { recursive: true, force: true })
    }
  })

  it('export fails closed on malformed pi_subagents config before writing anything', () => {
    const cwd = mkTempCwd()
    const customConfigDir = mkTempCwd()
    try {
      fs.writeFileSync(
        path.join(customConfigDir, 'systematic.json'),
        JSON.stringify({
          pi_subagents: { agents: { x: { thinking: 'turbo' } } },
        }),
      )

      const result = runCli(['pi-subagents', 'export'], cwd, {
        OPENCODE_CONFIG_DIR: customConfigDir,
      })
      expect(result.exitCode).not.toBe(0)
      expect(fs.existsSync(path.join(cwd, '.pi', 'agents'))).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(customConfigDir, { recursive: true, force: true })
    }
  })

  it('export with a remove-only plan (stale manifest-owned file, nothing to create/update) still invokes exportPersonas and removes the stale file', () => {
    const cwd = mkTempCwd()
    try {
      // Populate the manifest-owned persona set first via a real export.
      const first = runCli(['pi-subagents', 'export'], cwd)
      expect(first.exitCode).toBe(0)
      const agentsDir = path.join(cwd, '.pi', 'agents')

      // Inject a stale manifest entry (no longer curated) for a file that
      // exists on disk with a hash matching the manifest — this makes the
      // plan remove-only: no create/update/refuse actions, only `remove`.
      const manifestPath = path.join(agentsDir, MANIFEST_FILENAME)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        generatedAt: string
        agentsRoot: string
        files: { filename: string; hash: string; status: string }[]
      }
      const staleFilename = 'systematic-no-longer-curated.md'
      const staleContent = 'stale content'
      fs.writeFileSync(
        path.join(agentsDir, staleFilename),
        staleContent,
        'utf-8',
      )
      manifest.files.push({
        filename: staleFilename,
        hash: crypto.createHash('sha256').update(staleContent).digest('hex'),
        status: 'exported',
      })
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

      // Second export: every curated persona is already up to date (skip),
      // and the only action in the plan is the `remove` of the stale file.
      const result = runCli(['pi-subagents', 'export'], cwd)
      expect(result.exitCode).toBe(0)

      // The stale file must actually be removed — proves exportPersonas ran
      // rather than short-circuiting on "no create/update/refuse" work.
      expect(fs.existsSync(path.join(agentsDir, staleFilename))).toBe(false)

      // The final mutation-result line must not claim "no changes", since a
      // removal did happen (per-file preview lines legitimately say
      // "(up to date)" for the still-current personas — only the terminal
      // summary sentence is under test here).
      expect(result.stdout).not.toContain(
        'All persona files are already up to date. No changes.',
      )
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('uses injected config roots instead of process-global config locations', () => {
    const root = mkTempCwd()
    const globalCustomDir = path.join(root, 'global-custom')
    const previousCustomDir = process.env.OPENCODE_CONFIG_DIR
    try {
      fs.mkdirSync(globalCustomDir, { recursive: true })
      fs.writeFileSync(
        path.join(globalCustomDir, 'systematic.json'),
        JSON.stringify({
          bootstrap: { file: '/private/global-secret-path' },
          skills_as_commands: false,
        }),
      )
      const roots = {
        ...makeCapabilityRoots(root),
        configDir: path.join(root, 'injected-config'),
        opencodeConfigDirOverride: undefined,
      }
      process.env.OPENCODE_CONFIG_DIR = globalCustomDir

      const result = runObservedCapabilities(roots)
      const parsed = JSON.parse(result.stdout) as {
        facts: Array<Record<string, unknown>>
        sources: Array<Record<string, unknown>>
      }

      expect(result.status).toBe(0)
      expect(parsed.sources).not.toContainEqual(
        expect.objectContaining({
          sourceId: 'config:custom',
          presence: 'present',
        }),
      )
      expect(parsed.facts).not.toContainEqual(
        expect.objectContaining({
          fieldPath: 'skills_as_commands',
          sourceId: 'config:custom',
        }),
      )
      expect(result.stdout).not.toContain(globalCustomDir)
      expect(result.stdout).not.toContain('global-secret')
    } finally {
      if (previousCustomDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousCustomDir
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps successful capabilities stderr empty when config drops removed names', () => {
    const root = mkTempCwd()
    const home = path.join(root, 'home')
    const xdg = path.join(root, 'xdg')
    const custom = path.join(root, 'custom')
    const project = path.join(root, 'project')
    try {
      fs.mkdirSync(path.join(project, '.opencode'), { recursive: true })
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(xdg, { recursive: true })
      fs.mkdirSync(custom, { recursive: true })
      fs.writeFileSync(
        path.join(project, '.opencode/systematic.json'),
        JSON.stringify({ categories: { docs: {} } }),
      )

      const result = runCli(['capabilities'], project, {
        HOME: home,
        OPENCODE_CONFIG_DIR: custom,
        XDG_CONFIG_HOME: xdg,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(() => JSON.parse(result.stdout)).not.toThrow()
      expect(result.stderr).not.toContain('docs')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps valid skill winners while reporting a separate malformed-source fact', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-capabilities-'),
    )
    try {
      const roots = makeCapabilityRoots(root)
      const winnerDir = path.join(roots.cwd, '.opencode/skills/good')
      const brokenDir = path.join(roots.cwd, '.opencode/skills/broken')
      fs.mkdirSync(winnerDir, { recursive: true })
      fs.mkdirSync(brokenDir, { recursive: true })
      fs.writeFileSync(
        path.join(winnerDir, 'SKILL.md'),
        '---\nname: good\ndescription: winner\n---\nWinner body',
      )
      fs.writeFileSync(path.join(brokenDir, 'SKILL.md'), '---\nname: [broken')

      const result = runTestableCapabilities(roots)
      const parsed = JSON.parse(result.stdout) as {
        facts: Array<Record<string, unknown>>
      }

      expect(parsed.facts).toContainEqual({
        count: 1,
        discoveryId: 'skills',
        factId: 'discovery-summary',
        kind: 'discovery',
        sourceId: 'discovery:skills',
        status: 'available',
        winningRoots: ['project-opencode'],
      })
      expect(parsed.facts).toContainEqual({
        errorCode: 'source-malformed',
        factId: 'discovery-source-issue',
        kind: 'status',
        sourceId: 'discovery:skills',
        status: 'unavailable',
      })
      expect(
        parsed.facts.filter((fact) => fact.sourceId === 'discovery:skills'),
      ).toHaveLength(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('deduplicates symlink-equivalent capability roots at the CLI boundary', () => {
    const root = mkTempCwd()
    try {
      const roots = makeCapabilityRoots(root)
      const realRoot = path.join(root, 'real-root')
      const aliasRoot = path.join(root, 'alias-root')
      fs.mkdirSync(path.join(realRoot, 'agents'), { recursive: true })
      fs.writeFileSync(
        path.join(realRoot, 'package.json'),
        JSON.stringify({ name: '@fixture/systematic', version: '1.0.0' }),
      )
      fs.symlinkSync(realRoot, aliasRoot, 'dir')

      const result = runTestableCapabilities({
        ...roots,
        agentsRoot: path.join(realRoot, 'agents'),
        cwd: realRoot,
        packageRoot: aliasRoot,
      })
      const parsed = JSON.parse(result.stdout) as {
        roots: Array<{ id: string }>
      }

      expect(
        parsed.roots.filter(({ id }) => id === 'cwd' || id === 'package'),
      ).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('observes isolated valid and malformed config fixtures in a real subprocess', () => {
    const cases = [
      {
        name: 'valid',
        project: JSON.stringify({
          bootstrap: { enabled: false },
          workflow_guard: { mode: 'protected' },
        }),
        assert: (parsed: Record<string, unknown>) => {
          const facts = parsed.facts as Array<Record<string, unknown>>
          expect(facts).toContainEqual({
            factId: 'config-field-authority',
            fieldPath: 'bootstrap.enabled',
            kind: 'authority',
            sourceId: 'config:project',
            status: 'available',
          })
          expect(facts).toContainEqual({
            factId: 'config-field-authority',
            fieldPath: 'skills_as_commands',
            kind: 'authority',
            sourceId: 'config:custom',
            status: 'available',
          })
          expect(facts).toContainEqual({
            factId: 'config-protected-field',
            fieldPath: 'workflow_guard',
            kind: 'protection',
            outcome: 'blocked',
            sourceId: 'config:project',
            status: 'available',
          })
        },
      },
      {
        name: 'malformed-jsonc',
        project: '{ malformed secret }',
        assert: (parsed: Record<string, unknown>) => {
          expect(parsed.sources).toContainEqual({
            errorCode: 'source-malformed',
            kind: 'source',
            presence: 'invalid',
            sourceId: 'config:project',
            sourceKind: 'project',
          })
        },
      },
      {
        name: 'schema-invalid',
        project: JSON.stringify({ unknown_key: 'schema-secret' }),
        assert: (parsed: Record<string, unknown>) => {
          expect(parsed.sources).toContainEqual({
            errorCode: 'source-malformed',
            kind: 'source',
            presence: 'invalid',
            sourceId: 'config:project',
            sourceKind: 'project',
          })
        },
      },
    ] as const

    for (const fixture of cases) {
      const root = mkTempCwd()
      const home = path.join(root, 'home')
      const xdg = path.join(root, 'xdg')
      const custom = path.join(root, 'custom')
      const project = path.join(root, 'project')
      try {
        fs.mkdirSync(path.join(project, '.opencode'), { recursive: true })
        fs.mkdirSync(path.join(home, '.config/opencode'), {
          recursive: true,
        })
        fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true })
        fs.mkdirSync(custom, { recursive: true })
        fs.mkdirSync(xdg, { recursive: true })
        const userConfig = JSON.stringify({ workflow_guard: { debug: true } })
        fs.writeFileSync(
          path.join(home, '.config/opencode/systematic.json'),
          userConfig,
        )
        fs.writeFileSync(path.join(xdg, 'opencode/systematic.json'), userConfig)
        fs.writeFileSync(
          path.join(custom, 'systematic.json'),
          JSON.stringify({
            bootstrap: { file: '/private/custom-secret-path' },
            skills_as_commands: false,
          }),
        )
        fs.writeFileSync(
          path.join(project, '.opencode/systematic.json'),
          fixture.project,
        )
        const before = snapshotTree(root)
        const result = runCli(['capabilities'], project, {
          HOME: home,
          OPENCODE_CONFIG_DIR: custom,
          XDG_CONFIG_HOME: xdg,
        })
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        expect(parsed.command).toBe('systematic capabilities')
        fixture.assert(parsed)
        expect(result.stdout).not.toContain(root)
        expect(result.stdout).not.toContain('secret')
        expect(snapshotTree(root)).toBe(before)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })
})
