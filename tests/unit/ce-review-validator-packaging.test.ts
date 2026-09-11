// U4 packaging proof: the committed, self-contained Node validator shim
// (`skills/ce-review/scripts/validate-review.mjs`) is present and genuinely
// executes from every distributed shape a consumer can reach it through: the
// OCX-selected ce-review skill tree, a real `npm pack --ignore-scripts`
// archive, and the generated Claude Code plugin bundle. Every invocation runs
// against a synthetic project in its own temp directory; nothing here touches
// this repository's own `.context/`.
//
// Real Node is resolved independently (never Bun's `process.execPath`), and
// each packaged run asserts it is running under Node, not Bun.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.ts'
import {
  CE_REVIEW_VALIDATOR_RELATIVE_PATH,
  generateValidatorContent,
} from '../../scripts/generate-ce-review-validator.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const REGISTRY_PATH = path.join(REPO_ROOT, 'registry/registry.jsonc')
const VALIDATOR_REL = 'skills/ce-review/scripts/validate-review.mjs'
const VALIDATOR_SRC = path.join(REPO_ROOT, VALIDATOR_REL)
const CONFORMING_FIXTURE = path.join(
  REPO_ROOT,
  'tests/fixtures/review-artifacts/conforming-review-summary.json',
)

const VALID_RETURN = JSON.stringify({
  reviewer: 'correctness',
  findings: [],
  residual_risks: [],
  testing_gaps: [],
})

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

// ── Shared fixture plumbing ────────────────────────────────────────────────

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function runNode(
  scriptPath: string,
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly input?: string | Buffer
  } = {},
): RunResult {
  const result = spawnSync(NODE_BIN, [scriptPath, ...args], {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
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

function makeFakeProject(): string {
  const projectRoot = makeTempDir('ce-review-validator-project-')
  fs.mkdirSync(projectRoot, { recursive: true })
  return projectRoot
}

function writeContainedArtifact(projectRoot: string, content: string): void {
  const directory = path.join(projectRoot, '.context/systematic/ce-review')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'review-summary.json'), content)
}

// ── Registry (OCX) component reading ───────────────────────────────────────

interface RegistryComponent {
  readonly name: string
  readonly files?: readonly string[]
}

function readRegistryComponents(): RegistryComponent[] {
  const parsed: unknown = parseJsonc(fs.readFileSync(REGISTRY_PATH, 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed.components)) {
    throw new Error('registry.jsonc did not parse into { components: [] }')
  }
  return parsed.components.flatMap((entry): RegistryComponent[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return []
    return [
      {
        files: isStringArray(entry.files) ? entry.files : undefined,
        name: entry.name,
      },
    ]
  })
}

function findComponent(name: string): RegistryComponent {
  const component = readRegistryComponents().find((c) => c.name === name)
  if (!component) throw new Error(`registry component "${name}" not found`)
  return component
}

function copyDeclaredFiles(destRoot: string, files: readonly string[]): void {
  for (const relPath of files) {
    const dest = path.join(destRoot, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, relPath), dest)
  }
}

// ── Shared execution battery ───────────────────────────────────────────────

function skillDirScriptPath(skillDir: string): string {
  return path.join(skillDir, 'scripts/validate-review.mjs')
}

/**
 * Run the full `return` + `artifact` battery against a packaged script path
 * that was resolved through a layout's real `skills/ce-review` directory.
 */
function exercisePackagedScript(scriptPath: string, label: string): void {
  const projectRoot = makeFakeProject()
  const before = snapshotTree(projectRoot)

  // `return` subcommand: conforming and malformed stdin.
  const valid = runNode(scriptPath, ['return'], {
    cwd: projectRoot,
    input: VALID_RETURN,
  })
  expect(valid.exitCode, `${label}: valid return`).toBe(0)
  expect(valid.stdout).toContain('Review return is valid')

  const malformed = runNode(scriptPath, ['return'], {
    cwd: projectRoot,
    input: '{ malformed json',
  })
  expect(malformed.exitCode, `${label}: malformed return`).toBe(1)
  expect(malformed.stderr).toContain('not valid JSON')

  // Unknown/missing subcommands cannot fall through to either validator.
  for (const argv of [[], ['bogus']]) {
    const unknown = runNode(scriptPath, argv, { cwd: projectRoot })
    expect(unknown.exitCode, `${label}: ${argv.join(' ') || 'no args'}`).toBe(2)
    expect(unknown.stderr).toContain('return|artifact')
  }

  // The `return` path never writes into the project cwd.
  expect(snapshotTree(projectRoot), `${label}: return wrote to cwd`).toBe(
    before,
  )

  // `artifact` subcommand: cwd-contained valid, malformed, and schema-invalid.
  const artifactArgs = ['.context/systematic/ce-review/review-summary.json']
  writeContainedArtifact(
    projectRoot,
    fs.readFileSync(CONFORMING_FIXTURE, 'utf8'),
  )
  const afterArtifactWrite = snapshotTree(projectRoot)
  const artifactValid = runNode(scriptPath, ['artifact', ...artifactArgs], {
    cwd: projectRoot,
  })
  expect(artifactValid.exitCode, `${label}: valid artifact`).toBe(0)
  expect(artifactValid.stdout).toContain('Review artifact is valid')

  writeContainedArtifact(projectRoot, '{ malformed json')
  const artifactMalformed = runNode(scriptPath, ['artifact', ...artifactArgs], {
    cwd: projectRoot,
  })
  expect(artifactMalformed.exitCode, `${label}: malformed artifact`).toBe(2)
  expect(artifactMalformed.stderr).toContain('malformed JSON')

  writeContainedArtifact(projectRoot, JSON.stringify({ schema_version: 2 }))
  const beforeLastRun = snapshotTree(projectRoot)
  const artifactInvalid = runNode(scriptPath, ['artifact', ...artifactArgs], {
    cwd: projectRoot,
  })
  expect(artifactInvalid.exitCode, `${label}: schema-invalid artifact`).toBe(1)

  // The `artifact` path never writes into the project cwd (the artifact file is
  // rewritten by this test between runs, not by the validator).
  expect(snapshotTree(projectRoot), `${label}: artifact wrote to cwd`).toBe(
    beforeLastRun,
  )
  expect(afterArtifactWrite).toContain('review-summary.json')
}

function assertRunsUnderRealNode(scriptPath: string, label: string): void {
  const driver = `
const mod = await import(${JSON.stringify(pathToFileURL(scriptPath).href)})
if (typeof Bun !== 'undefined') { console.error('ran under Bun'); process.exit(3) }
if (typeof mod.runCeReviewValidator !== 'function') { console.error('missing export'); process.exit(4) }
console.log('node-ok')
`
  const result = spawnSync(NODE_BIN, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.status, `${label}: ${result.stderr}`).toBe(0)
  expect(result.stdout).toContain('node-ok')
}

// ═══════════════════════════════════════════════════════════════════════════
// Committed artifact precondition
// ═══════════════════════════════════════════════════════════════════════════

describe('committed ce:review validator shim', () => {
  test('exists at the declared shipped path', () => {
    expect(fs.existsSync(VALIDATOR_SRC)).toBe(true)
  })

  test('has no shebang and no relative or TypeScript-source imports', () => {
    const source = fs.readFileSync(VALIDATOR_SRC, 'utf8')
    expect(source.startsWith('#!')).toBe(false)
    expect(source).not.toMatch(/from\s+['"]\.{1,2}\//)
    expect(source).not.toMatch(/require\(/)
    expect(source).not.toMatch(/from\s+['"][^'"]*\.ts['"]/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Channel 1: OCX-selected ce-review skill tree
// ═══════════════════════════════════════════════════════════════════════════

describe('OCX-selected ce-review skill tree', () => {
  test('the ce-review component declares the validator and no other component does', () => {
    const declared = readRegistryComponents().filter((component) =>
      (component.files ?? []).includes(VALIDATOR_REL),
    )
    expect(declared.map((component) => component.name)).toEqual(['ce-review'])
  })

  test('executes return/artifact subcommands from the copied declared-file tree', () => {
    const component = findComponent('ce-review')
    if (!component.files) throw new Error('ce-review declares no files')
    const consumerRoot = makeTempDir('ocx-ce-review-validator-')
    copyDeclaredFiles(consumerRoot, component.files)

    const scriptPath = skillDirScriptPath(
      path.join(consumerRoot, 'skills/ce-review'),
    )
    expect(fs.existsSync(scriptPath)).toBe(true)
    expect(fs.readFileSync(scriptPath).equals(fs.readFileSync(VALIDATOR_SRC)))

    exercisePackagedScript(scriptPath, 'ocx')
    assertRunsUnderRealNode(scriptPath, 'ocx')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Channel 2: real `npm pack --ignore-scripts` archive
// ═══════════════════════════════════════════════════════════════════════════

describe('npm-packed archive', () => {
  let extractDir: string

  beforeAll(() => {
    const packDestDir = makeTempDir('ce-review-validator-npmpack-')
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

    extractDir = makeTempDir('ce-review-validator-npmextract-')
    const extract = spawnSync(
      'tar',
      ['xzf', path.join(packDestDir, tarballName), '-C', extractDir],
      { timeout: 30_000 },
    )
    if (extract.status !== 0) {
      throw new Error('tar extraction failed')
    }
  }, 120_000)

  test('tarball ships the validator byte-identical at its skill path', () => {
    const packaged = path.join(extractDir, 'package', VALIDATOR_REL)
    expect(fs.existsSync(packaged)).toBe(true)
    expect(fs.readFileSync(packaged).equals(fs.readFileSync(VALIDATOR_SRC)))
  })

  test('executes both subcommands from the extracted archive', () => {
    const scriptPath = skillDirScriptPath(
      path.join(extractDir, 'package/skills/ce-review'),
    )
    exercisePackagedScript(scriptPath, 'npm')
    assertRunsUnderRealNode(scriptPath, 'npm')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Channel 3: generated Claude Code plugin bundle
// ═══════════════════════════════════════════════════════════════════════════

describe('Claude Code generated plugin', () => {
  let outDir: string

  beforeAll(() => {
    const files = generatePluginFiles(
      REPO_ROOT,
      Buffer.from('placeholder validator bundle'),
    )
    outDir = makeTempDir('ce-review-validator-cc-')
    writePluginFiles(files, outDir)
  }, 60_000)

  test('bundle includes the validator byte-identical at its skill path', () => {
    const packaged = path.join(outDir, VALIDATOR_REL)
    expect(fs.existsSync(packaged)).toBe(true)
    expect(fs.readFileSync(packaged).equals(fs.readFileSync(VALIDATOR_SRC)))
  })

  test('executes both subcommands from the written output tree', () => {
    const scriptPath = skillDirScriptPath(path.join(outDir, 'skills/ce-review'))
    exercisePackagedScript(scriptPath, 'claude-code')
    assertRunsUnderRealNode(scriptPath, 'claude-code')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Failure modes: unavailable must never be conflated with malformed input
// ═══════════════════════════════════════════════════════════════════════════

describe('unavailable validator surfaces as an error, not malformed input', () => {
  test('a missing script fails loudly and does not report malformed reviewer input', () => {
    const missing = path.join(
      makeTempDir('ce-review-validator-missing-'),
      'validate-review.mjs',
    )
    const result = runNode(missing, ['return'], { input: VALID_RETURN })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/Cannot find module|ENOENT|MODULE_NOT_FOUND/)
    expect(result.stderr).not.toContain('not valid JSON')
    expect(result.stderr).not.toContain('Review return is valid')
  })

  test('a directory in place of the script is an operational error, not a reviewer verdict', () => {
    const dirAsScript = makeTempDir('ce-review-validator-dirscript-')
    const result = runNode(dirAsScript, ['return'], { input: VALID_RETURN })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toContain('not valid JSON')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Workflow drift wiring (source-level, no brittle line numbers)
// ═══════════════════════════════════════════════════════════════════════════

describe('drift wiring', () => {
  test('main CI and Fro Bot invoke the validator bundle drift check', () => {
    for (const workflow of ['main.yaml', 'fro-bot.yaml']) {
      const content = fs.readFileSync(
        path.join(REPO_ROOT, '.github/workflows', workflow),
        'utf8',
      )
      expect(content, workflow).toContain('ce-review-validator:drift')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Generator drift: missing/stale bytes fail loudly, generation is deterministic
// ═══════════════════════════════════════════════════════════════════════════

describe('generator drift', () => {
  const GENERATOR = path.join(
    REPO_ROOT,
    'scripts/generate-ce-review-validator.ts',
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
    }
  }

  test('--check passes for the committed bundle', () => {
    const result = runGenerator(['--check'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain(CE_REVIEW_VALIDATOR_RELATIVE_PATH)
  })

  test('generator output is deterministic', () => {
    expect(generateValidatorContent()).toBe(generateValidatorContent())
  })

  test('stale committed bytes fail --check and name the path', () => {
    const original = fs.readFileSync(VALIDATOR_SRC, 'utf8')
    try {
      fs.writeFileSync(VALIDATOR_SRC, `${original}\n`)
      const result = runGenerator(['--check'])

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain(VALIDATOR_REL)
    } finally {
      fs.writeFileSync(VALIDATOR_SRC, original)
    }
  })

  test('a missing committed bundle fails --check and names the path', () => {
    const original = fs.readFileSync(VALIDATOR_SRC, 'utf8')
    try {
      fs.rmSync(VALIDATOR_SRC)
      const result = runGenerator(['--check'])

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('does not exist')
      expect(`${result.stdout}${result.stderr}`).toContain(VALIDATOR_REL)
    } finally {
      fs.writeFileSync(VALIDATOR_SRC, original)
    }
  })
})
