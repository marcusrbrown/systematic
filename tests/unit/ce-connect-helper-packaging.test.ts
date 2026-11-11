// Packaging proof: the committed, self-contained Node helper
// (`skills/ce-connect/scripts/connect.mjs`) is present and genuinely executes
// from every distributed shape a consumer can reach it through: the
// OCX-selected ce-connect skill tree, a real `npm pack --ignore-scripts`
// archive, and the generated Claude Code plugin bundle. Every run drives the
// real command line under real Node, against throwaway repositories, a throwaway
// home and a throwaway state directory.
//
// The OCX and Claude Code layouts use a temporary copy of the real tree.
// Both layouts ship only directories holding a `SKILL.md`, so fixture setup
// must fail if the real skill is missing rather than inventing one and
// hiding a broken distribution.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.ts'
import {
  CE_CONNECT_HELPER_RELATIVE_PATH,
  generateHelperContent,
} from '../../scripts/generate-ce-connect-helper.ts'
import { generateRegistryContent } from '../../scripts/generate-registry.ts'
import { ruleIdFor } from '../../src/lib/connect-helper-core.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const HELPER_REL = 'skills/ce-connect/scripts/connect.mjs'
const HELPER_SRC = path.join(REPO_ROOT, HELPER_REL)

// ── Real Node binary, resolved before any environment mutation ─────────────

const nodeProbe = spawnSync('node', ['-p', 'process.execPath'], {
  encoding: 'utf8',
})
if (nodeProbe.status !== 0 || !nodeProbe.stdout.trim()) {
  throw new Error(
    'fixture setup failed: `node -p process.execPath` did not resolve a Node binary',
  )
}
const NODE_BIN = nodeProbe.stdout.trim()

const bunCheck = spawnSync(NODE_BIN, ['-p', "typeof Bun === 'undefined'"], {
  encoding: 'utf8',
})
if (bunCheck.status !== 0 || bunCheck.stdout.trim() !== 'true') {
  throw new Error(
    'resolved Node binary appears to be Bun, not a real Node runtime -- refusing to run packaging checks against it',
  )
}

// ── Shared plumbing ────────────────────────────────────────────────────────

const TEMP_DIRS: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  TEMP_DIRS.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

type Json = Record<string, unknown>

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly json: Json | undefined
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function createProject(files: Record<string, string>): string {
  const work = makeTempDir('connect-pack-project-')
  git(work, ['init', '-q', '-b', 'main'])
  git(work, ['config', 'gc.auto', '0'])
  git(work, ['config', 'maintenance.auto', 'false'])
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(work, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    git(work, ['add', '-f', '--', `:(literal)${rel}`])
  }
  git(work, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '-m',
    'base',
    '--no-verify',
    '--allow-empty',
  ])
  return work
}

function snapshotTree(root: string): string {
  const entries: string[] = []
  function visit(directory: string, relative = ''): void {
    for (const child of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.join(relative, child.name)
      const childPath = path.join(directory, child.name)
      if (child.isDirectory()) {
        entries.push(`${childRelative}/`)
        visit(childPath, childRelative)
      } else {
        entries.push(
          `${childRelative}:${fs.readFileSync(childPath).toString('base64')}`,
        )
      }
    }
  }
  visit(root)
  return entries.join('\n')
}

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text.trim().split('\n').at(-1) ?? '')
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : undefined
  } catch {
    return undefined
  }
}

const LOCK_LEARNING = [
  '---',
  'title: Reclaim stale locks only on verified identity',
  'applies_when:',
  '  - A lock file can outlive the process that took it',
  '---',
  '',
  '## Guidance',
  '',
  'Never reclaim a lock without verifying the holder identity first.',
  '',
  '## Prevention',
  '',
  'Record the holder start time next to the pid.',
  '',
].join('\n')

const NOW_LEARNING = [
  '---',
  'title: Reclaim stale locks at once',
  'applies_when: A lock file can outlive the process that took it',
  '---',
  '',
  '## Guidance',
  '',
  'Always reclaim a stale lock immediately after the timeout.',
  '',
].join('\n')

interface Scenario {
  readonly source: string
  readonly target: string
  readonly env: Record<string, string>
  readonly stateHome: string
}

function buildScenario(): Scenario {
  const source = createProject({
    'docs/solutions/lock-reclaim.md': LOCK_LEARNING,
  })
  const target = createProject({ 'docs/solutions/lock-now.md': NOW_LEARNING })
  const home = makeTempDir('connect-pack-home-')
  const configDir = path.join(home, '.config', 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'systematic.json'),
    JSON.stringify({ connect: { allow_projects: [source, target] } }),
  )
  const stateHome = path.join(makeTempDir('connect-pack-state-'), 'xdg')
  return {
    source,
    target,
    stateHome,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_STATE_HOME: stateHome,
    },
  }
}

function runHelper(
  scriptPath: string,
  args: readonly string[],
  scenario: Scenario,
  request?: unknown,
): RunResult {
  const result = spawnSync(NODE_BIN, [scriptPath, ...args], {
    cwd: scenario.source,
    env: scenario.env,
    input: request === undefined ? undefined : JSON.stringify(request),
    encoding: 'utf8',
    timeout: 60_000,
  })
  const stdout = result.stdout ?? ''
  return {
    exitCode: result.status ?? -1,
    stdout,
    stderr: result.stderr ?? '',
    json: parseJson(stdout),
  }
}

function contradiction(
  scenario: Scenario,
  ruleId: string,
): Record<string, unknown> {
  return {
    kind: 'contradiction',
    ruleId,
    target: scenario.target,
    title: 'Two projects disagree on lock reclaim',
    summary: 'One says verify first; the other says reclaim at once.',
    nextStep: 'refresh-learning',
    overlapCheck: { queries: ['reclaim'], result: 'none-found' },
    sources: [
      {
        project: scenario.source,
        path: 'docs/solutions/lock-reclaim.md',
        fingerprint: sha256(LOCK_LEARNING),
        excerpt: 'Never reclaim a lock without verifying the holder identity',
      },
      {
        project: scenario.target,
        path: 'docs/solutions/lock-now.md',
        fingerprint: sha256(NOW_LEARNING),
        excerpt: 'Always reclaim a stale lock immediately after the timeout',
      },
    ],
    targetEvidence: [],
    counterevidence: [],
  }
}

/** One full run through the real command line, with the failure paths around it. */
function exerciseHelper(scriptPath: string, label: string): void {
  const scenario = buildScenario()
  const before = [snapshotTree(scenario.source), snapshotTree(scenario.target)]

  for (const argv of [[], ['bogus'], ['ledger'], ['ledger', 'nope']]) {
    const usage = runHelper(scriptPath, argv, scenario)
    expect(usage.exitCode, `${label}: ${argv.join(' ') || 'no args'}`).toBe(2)
    expect(usage.stderr).toContain('Usage: node connect.mjs')
  }

  // Headless on a host with no observed deny is refused before anything is written.
  const refused = runHelper(scriptPath, ['begin'], scenario, {
    host: 'pi',
    version: '0.1.0',
    mode: 'headless',
  })
  expect(refused.exitCode, `${label}: headless refusal`).toBe(1)
  expect(refused.json?.reason).toBe('unsupported-host')
  expect(fs.existsSync(scenario.stateHome)).toBe(false)

  const consent = runHelper(scriptPath, ['begin'], scenario, {
    host: 'pi',
    version: '0.1.0',
    mode: 'interactive',
  })
  expect(consent.exitCode).toBe(1)
  expect(consent.json?.outcome).toBe('consent-required')

  const notJson = spawnSync(NODE_BIN, [scriptPath, 'begin'], {
    cwd: scenario.source,
    env: scenario.env,
    input: '{ not json',
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(notJson.status).toBe(2)
  expect(parseJson(notJson.stdout ?? '')?.reason).toBe('request-not-json')

  // Interactive, user agreed: the run begins and holds the lock across processes.
  const begun = runHelper(scriptPath, ['begin'], scenario, {
    host: 'pi',
    version: '0.1.0',
    mode: 'interactive',
    consent: true,
  })
  expect(begun.exitCode, `${label}: begin ${begun.stdout}`).toBe(0)
  const body = begun.json as Json
  expect(body.status).toBe('begun')
  const runId = body.runId as string
  const workDir = body.workDir as string
  const lock = body.lock as Json
  expect(body.ruleCount).toBe(2)

  const busy = runHelper(scriptPath, ['begin'], scenario, {
    host: 'pi',
    version: '0.1.0',
    mode: 'interactive',
    consent: true,
  })
  expect(busy.exitCode, `${label}: second begin`).toBe(1)
  expect(busy.json?.outcome).toBe('busy')

  const ruleId = ruleIdFor(scenario.source, 'docs/solutions/lock-reclaim.md')
  const batch = path.join(workDir, 'batch-1.json')
  fs.writeFileSync(
    batch,
    JSON.stringify({
      version: 1,
      runId,
      family: 'locking',
      ruleIds: [
        ruleId,
        ruleIdFor(scenario.target, 'docs/solutions/lock-now.md'),
      ],
      projects: [scenario.source, scenario.target],
      files: ['docs/solutions/lock-reclaim.md'],
      searches: ['reclaim lock'],
      complete: true,
      candidates: [contradiction(scenario, ruleId)],
    }),
  )
  const validated = runHelper(scriptPath, ['validate'], scenario, {
    runId,
    lock,
    batches: [batch],
  })
  expect(validated.exitCode, `${label}: validate ${validated.stdout}`).toBe(0)
  expect(validated.json?.pendingOutcome).toBe('complete')
  expect((validated.json?.accepted as unknown[] | undefined)?.length).toBe(1)

  const published = runHelper(scriptPath, ['publish'], scenario, {
    runId,
    lock,
  })
  expect(published.exitCode, `${label}: publish ${published.stdout}`).toBe(0)
  expect(published.json?.outcome).toBe('complete')
  expect(published.json?.finalLine).toBe('Connect complete')
  const digest = fs.readFileSync(published.json?.digestPath as string, 'utf8')
  expect(digest).toContain('docs/solutions/lock-reclaim.md')
  expect(digest).toContain('docs/solutions/lock-now.md')
  expect(digest).toContain(sha256(LOCK_LEARNING))
  expect(
    fs.existsSync(path.join(scenario.stateHome, 'systematic/connect/lock')),
  ).toBe(false)

  const shown = runHelper(scriptPath, ['ledger', 'show'], scenario)
  expect(shown.exitCode).toBe(0)
  const entries = shown.json?.entries as Array<Json>
  expect(entries).toHaveLength(1)
  expect(entries[0]?.status).toBe('candidate')

  const decided = runHelper(scriptPath, ['decide'], scenario, {
    id: entries[0]?.id,
    status: 'rejected',
    reason: 'Context-specific, no write needed.',
  })
  expect(decided.exitCode, `${label}: decide ${decided.stdout}`).toBe(0)
  const after = runHelper(scriptPath, ['ledger', 'show'], scenario)
  expect(((after.json?.entries ?? []) as Array<Json>)[0]?.status).toBe(
    'rejected',
  )

  // The lock is free again; an abort releases it without publishing.
  const second = runHelper(scriptPath, ['begin'], scenario, {
    host: 'pi',
    version: '0.1.0',
    mode: 'interactive',
    consent: true,
  })
  expect(second.exitCode).toBe(0)
  const aborted = runHelper(scriptPath, ['publish'], scenario, {
    runId: second.json?.runId,
    lock: second.json?.lock,
    abort: true,
  })
  expect(aborted.exitCode).toBe(0)
  expect(aborted.json?.outcome).toBe('aborted')

  expect(
    [snapshotTree(scenario.source), snapshotTree(scenario.target)],
    `${label}: an allowed project changed`,
  ).toEqual(before)
}

function assertRunsUnderRealNode(scriptPath: string, label: string): void {
  const scenario = buildScenario()
  const result = runHelper(scriptPath, ['ledger', 'show'], scenario)
  expect(result.exitCode, `${label}: ${result.stderr}`).toBe(0)
  expect(result.json?.ok).toBe(true)
}

// ── A temporary tree in which the skill has a SKILL.md ─────────────────────

let layoutRoot: string

function prepareLayoutRoot(sourceRoot = REPO_ROOT): string {
  const root = makeTempDir('connect-pack-layout-')
  for (const rel of [
    'package.json',
    'agents',
    'skills',
    'registry',
    'biome.json',
  ]) {
    fs.cpSync(path.join(sourceRoot, rel), path.join(root, rel), {
      recursive: true,
    })
  }
  const skillFile = path.join(root, 'skills/ce-connect/SKILL.md')
  fs.readFileSync(skillFile)
  return root
}

beforeAll(() => {
  layoutRoot = prepareLayoutRoot()
}, 60_000)

describe('packaging layout preconditions', () => {
  test('copies the real skill without changing its bytes', () => {
    const relativePath = 'skills/ce-connect/SKILL.md'
    expect(
      fs
        .readFileSync(path.join(layoutRoot, relativePath))
        .equals(fs.readFileSync(path.join(REPO_ROOT, relativePath))),
    ).toBe(true)
  })

  test('rejects a source tree missing the real skill instead of synthesizing it', () => {
    const sourceRoot = prepareLayoutRoot()
    const skillFile = path.join(sourceRoot, 'skills/ce-connect/SKILL.md')
    fs.unlinkSync(skillFile)

    expect(() => prepareLayoutRoot(sourceRoot)).toThrow(/ENOENT/)
    expect(fs.existsSync(skillFile)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Committed artifact precondition
// ═══════════════════════════════════════════════════════════════════════════

describe('committed ce:connect helper', () => {
  test('exists at the declared shipped path', () => {
    expect(CE_CONNECT_HELPER_RELATIVE_PATH).toBe(HELPER_REL)
    expect(fs.existsSync(HELPER_SRC)).toBe(true)
  })

  test('has no shebang, no relative or TypeScript-source imports, and inlines its dependencies', () => {
    const source = fs.readFileSync(HELPER_SRC, 'utf8')
    expect(source.startsWith('#!')).toBe(false)
    expect(source).not.toMatch(/from\s+['"]\.{1,2}\//)
    expect(source).not.toMatch(/from\s+['"][^'"]*\.ts['"]/)
    expect(source).not.toMatch(/from\s+['"](?:js-yaml|jsonc-parser|zod)['"]/)
    expect(source).not.toMatch(
      /require\(['"](?:js-yaml|jsonc-parser|zod)['"]\)/,
    )
  })

  test('runs from a directory with no node_modules', () => {
    const lonely = makeTempDir('connect-pack-lonely-')
    fs.copyFileSync(HELPER_SRC, path.join(lonely, 'connect.mjs'))
    assertRunsUnderRealNode(path.join(lonely, 'connect.mjs'), 'lonely')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Channel 1: OCX-selected ce-connect skill tree
// ═══════════════════════════════════════════════════════════════════════════

describe('OCX-selected ce-connect skill tree', () => {
  test('the ce-connect component declares the helper and no other component does', () => {
    const parsed: unknown = parseJsonc(generateRegistryContent(layoutRoot))
    const components = (parsed as { components: Array<Json> }).components
    const declared = components.filter((component) =>
      ((component.files as string[] | undefined) ?? []).includes(HELPER_REL),
    )
    expect(declared.map((component) => component.name)).toEqual(['ce-connect'])
  })

  test('executes the full run from the copied declared-file tree', () => {
    const parsed: unknown = parseJsonc(generateRegistryContent(layoutRoot))
    const component = (parsed as { components: Array<Json> }).components.find(
      (item) => item.name === 'ce-connect',
    )
    const files = component?.files as string[] | undefined
    if (files === undefined) throw new Error('ce-connect declares no files')
    const consumerRoot = makeTempDir('ocx-ce-connect-')
    for (const rel of files) {
      const dest = path.join(consumerRoot, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(path.join(layoutRoot, rel), dest)
    }
    const scriptPath = path.join(consumerRoot, HELPER_REL)
    expect(
      fs.readFileSync(scriptPath).equals(fs.readFileSync(HELPER_SRC)),
    ).toBe(true)
    exerciseHelper(scriptPath, 'ocx')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Channel 2: real `npm pack --ignore-scripts` archive
// ═══════════════════════════════════════════════════════════════════════════

describe('npm-packed archive', () => {
  let extractDir: string

  beforeAll(() => {
    const packDestDir = makeTempDir('ce-connect-npmpack-')
    const pack = spawnSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--pack-destination',
        packDestDir,
        '--silent',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    )
    if (pack.status !== 0) {
      throw new Error(`npm pack failed (exit ${pack.status})\n${pack.stderr}`)
    }
    const tarballName = pack.stdout.trim().split('\n').at(-1)
    if (!tarballName) throw new Error('npm pack produced no tarball filename')

    extractDir = makeTempDir('ce-connect-npmextract-')
    const extract = spawnSync(
      'tar',
      ['xzf', path.join(packDestDir, tarballName), '-C', extractDir],
      { timeout: 30_000 },
    )
    if (extract.status !== 0) {
      throw new Error('tar extraction failed')
    }
  }, 120_000)

  test('tarball ships the helper byte-identical at its skill path', () => {
    const packaged = path.join(extractDir, 'package', HELPER_REL)
    expect(fs.existsSync(packaged)).toBe(true)
    expect(fs.readFileSync(packaged).equals(fs.readFileSync(HELPER_SRC))).toBe(
      true,
    )
  })

  test('executes the full run from the extracted archive', () => {
    exerciseHelper(path.join(extractDir, 'package', HELPER_REL), 'npm')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Channel 3: generated Claude Code plugin bundle
// ═══════════════════════════════════════════════════════════════════════════

describe('Claude Code generated plugin', () => {
  let outDir: string

  beforeAll(() => {
    const files = generatePluginFiles(
      layoutRoot,
      Buffer.from('placeholder validator bundle'),
    )
    outDir = makeTempDir('ce-connect-cc-')
    writePluginFiles(files, outDir)
  }, 60_000)

  test('bundle includes the helper byte-identical at its skill path', () => {
    const packaged = path.join(outDir, HELPER_REL)
    expect(fs.existsSync(packaged)).toBe(true)
    expect(fs.readFileSync(packaged).equals(fs.readFileSync(HELPER_SRC))).toBe(
      true,
    )
  })

  test('executes the full run from the written output tree', () => {
    exerciseHelper(path.join(outDir, HELPER_REL), 'claude-code')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Failure modes: unavailable must never be conflated with a helper outcome
// ═══════════════════════════════════════════════════════════════════════════

describe('unavailable helper surfaces as an error, not a helper outcome', () => {
  test('a missing script fails loudly and reports no outcome', () => {
    const missing = path.join(makeTempDir('ce-connect-missing-'), 'connect.mjs')
    const scenario = buildScenario()
    const result = runHelper(missing, ['ledger', 'show'], scenario)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/Cannot find module|ENOENT|MODULE_NOT_FOUND/)
    expect(result.json).toBeUndefined()
  })

  test('a directory in place of the script is an operational error', () => {
    const dirAsScript = makeTempDir('ce-connect-dirscript-')
    const scenario = buildScenario()
    const result = runHelper(dirAsScript, ['ledger', 'show'], scenario)

    expect(result.exitCode).not.toBe(0)
    expect(result.json).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Generator drift: missing/stale bytes fail loudly, generation is deterministic
// ═══════════════════════════════════════════════════════════════════════════

describe('generator drift', () => {
  const GENERATOR = path.join(
    REPO_ROOT,
    'scripts/generate-ce-connect-helper.ts',
  )

  function runGenerator(args: string[]): RunResult {
    const result = spawnSync('bun', [GENERATOR, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    })
    return {
      exitCode: result.status ?? -1,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
      json: undefined,
    }
  }

  test('--check passes for the committed bundle', () => {
    const result = runGenerator(['--check'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain(HELPER_REL)
  })

  test('generator output is deterministic', async () => {
    expect(await generateHelperContent()).toBe(await generateHelperContent())
  })

  test('the committed bytes carry the digest the current sources produce', async () => {
    const generated = await generateHelperContent()
    const digestLine = /^\/\/ source-digest: [0-9a-f]{64}$/m
    expect(generated.match(digestLine)?.[0]).toBe(
      fs.readFileSync(HELPER_SRC, 'utf8').match(digestLine)?.[0],
    )
  })

  test('a stamped digest that no longer matches sources fails --check and names the path', () => {
    const original = fs.readFileSync(HELPER_SRC, 'utf8')
    try {
      const corrupted = original.replace(
        /^\/\/ source-digest: [0-9a-f]{64}$/m,
        `// source-digest: ${'0'.repeat(64)}`,
      )
      expect(corrupted).not.toBe(original)
      fs.writeFileSync(HELPER_SRC, corrupted)
      const result = runGenerator(['--check'])

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain(HELPER_REL)
      expect(`${result.stdout}${result.stderr}`).toContain(
        'generated from different sources',
      )
    } finally {
      fs.writeFileSync(HELPER_SRC, original)
    }
  })

  test('a missing committed bundle fails --check and names the path', () => {
    const original = fs.readFileSync(HELPER_SRC, 'utf8')
    try {
      fs.rmSync(HELPER_SRC)
      const result = runGenerator(['--check'])

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('does not exist')
      expect(`${result.stdout}${result.stderr}`).toContain(HELPER_REL)
    } finally {
      fs.writeFileSync(HELPER_SRC, original)
    }
  })
})
