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
import {
  applyReviewAdjudication,
  prepareReviewCandidates,
  screenReviewReturn,
} from '../../src/lib/review-pipeline.js'

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

// ── Pipeline-phase (screen/prepare/merge/finalize) fixtures ────────────────
//
// One independently schema-conforming envelope and one malformed envelope
// per phase, reused across every packaged layout below. These are minimal on
// purpose -- proving each subcommand actually routes and validates under
// real Node from every distributed shape, not exercising pipeline semantics
// (the repair-class fixture further down drives the real cross-phase
// scenario instead).

const PIPELINE_SCREEN_ARGS = [
  'screen',
  '--reviewer',
  'correctness',
  '--harness',
  'claude-code',
] as const

const PIPELINE_SCREEN_RETURN = {
  findings: [
    {
      autofix_class: 'gated_auto',
      confidence: 0.85,
      evidence: ['src/example.ts:42 demonstrates the failure path.'],
      file: 'src/example.ts',
      line: 42,
      owner: 'downstream-resolver',
      pre_existing: false,
      requires_verification: true,
      severity: 'P1',
      suggested_fix: 'Handle the failure before continuing.',
      title: 'Example issue',
      why_it_matters: 'The example path can fail during normal execution.',
    },
  ],
  residual_risks: [],
  reviewer: 'correctness',
  testing_gaps: [],
}

const PIPELINE_PREPARE_ARGS = ['prepare'] as const

const PIPELINE_PREPARE_INPUT = {
  screen_results: [
    {
      reviewer: 'correctness',
      result: {
        admitted_findings: [
          {
            ...PIPELINE_SCREEN_RETURN.findings[0],
            disposition: 'surviving',
            input_id: 'correctness#0',
          },
        ],
        dispatch_outcome: 'findings',
        harness: 'opencode',
        residual_risks: [],
        testing_gaps: [],
      },
    },
  ],
  selected_dispatches: [
    {
      dispatch_outcome: 'findings',
      persona: 'correctness',
      selection_surface: ['src/example.ts'],
    },
  ],
}

const PIPELINE_MERGE_ARGS = ['merge'] as const

// The AE16 shape: zero candidate groups, so the only valid adjudication is
// an empty decision set.
const PIPELINE_MERGE_INPUT = {
  adjudication: { decisions: [] },
  prepared: {
    candidate_groups: [],
    confidence_dispositions: [],
    coverage_union: [],
    singletons: [],
    surviving_findings: [],
  },
}

const PIPELINE_FINALIZE_ARGS = ['finalize'] as const

// The smallest schema-conforming finalize envelope: a report-only run with
// zero dispatches, so every join and coverage check has nothing to
// reconcile.
const PIPELINE_FINALIZE_INPUT = {
  merge: {
    disagreement_facts: [],
    merged_findings: [],
    validator_requests: [],
  },
  prepared: {
    candidate_groups: [],
    confidence_dispositions: [],
    coverage_union: [],
    singletons: [],
    surviving_findings: [],
  },
  screen_results: [],
  dispatch_records: [],
  validator_lifecycle_results: [],
  plan_assessment: { results: [], verdict: 'clean' },
  parent_run_metadata: {
    applied_fixes: [],
    branch: 'main',
    harness: 'opencode',
    head_sha: 'a'.repeat(40),
    mode: 'report-only',
    run_id: 'run-1',
    selected_dispatches: [],
    timestamps: {
      completed_at: '2026-01-01T00:05:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
    },
    validation: { reason: 'no autofix applied', status: 'not_attempted' },
  },
}

interface PipelinePhaseCase {
  readonly name: string
  readonly args: readonly string[]
  readonly conformingInput: unknown
  readonly malformedMessage: string
}

const PIPELINE_PHASE_CASES: readonly PipelinePhaseCase[] = [
  {
    args: PIPELINE_SCREEN_ARGS,
    conformingInput: PIPELINE_SCREEN_RETURN,
    malformedMessage: 'screen rejected the reviewer return',
    name: 'screen',
  },
  {
    args: PIPELINE_PREPARE_ARGS,
    conformingInput: PIPELINE_PREPARE_INPUT,
    malformedMessage: 'rejected the aggregate envelope',
    name: 'prepare',
  },
  {
    args: PIPELINE_MERGE_ARGS,
    conformingInput: PIPELINE_MERGE_INPUT,
    malformedMessage: 'rejected the aggregate envelope',
    name: 'merge',
  },
  {
    args: PIPELINE_FINALIZE_ARGS,
    conformingInput: PIPELINE_FINALIZE_INPUT,
    malformedMessage: 'finalize rejected the aggregate envelope',
    name: 'finalize',
  },
]

/**
 * Runs `screen`, `prepare`, `merge`, and `finalize` from a packaged script
 * path under real Node: one conforming envelope (exit 0, parseable stdout)
 * and one malformed envelope (exit 1, fixed stderr message, empty stdout)
 * per phase. Import-without-execution is already covered per layout by
 * `assertRunsUnderRealNode`, which this function's callers also invoke.
 */
function exercisePipelinePhases(scriptPath: string, label: string): void {
  for (const phase of PIPELINE_PHASE_CASES) {
    const conforming = runNode(scriptPath, [...phase.args], {
      input: JSON.stringify(phase.conformingInput),
    })
    expect(
      conforming.exitCode,
      `${label}: ${phase.name} conforming: ${conforming.stderr}`,
    ).toBe(0)
    expect(() => JSON.parse(conforming.stdout)).not.toThrow()

    const malformed = runNode(scriptPath, [...phase.args], {
      input: '{ not json',
    })
    expect(malformed.exitCode, `${label}: ${phase.name} malformed`).toBe(1)
    expect(malformed.stderr).toContain(phase.malformedMessage)
    expect(malformed.stdout).toBe('')
  }
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
    expect(
      fs.readFileSync(scriptPath).equals(fs.readFileSync(VALIDATOR_SRC)),
    ).toBe(true)

    exercisePackagedScript(scriptPath, 'ocx')
    assertRunsUnderRealNode(scriptPath, 'ocx')
    exercisePipelinePhases(scriptPath, 'ocx')
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
    expect(
      fs.readFileSync(packaged).equals(fs.readFileSync(VALIDATOR_SRC)),
    ).toBe(true)
  })

  test('executes both subcommands from the extracted archive', () => {
    const scriptPath = skillDirScriptPath(
      path.join(extractDir, 'package/skills/ce-review'),
    )
    exercisePackagedScript(scriptPath, 'npm')
    assertRunsUnderRealNode(scriptPath, 'npm')
    exercisePipelinePhases(scriptPath, 'npm')
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
    expect(
      fs.readFileSync(packaged).equals(fs.readFileSync(VALIDATOR_SRC)),
    ).toBe(true)
  })

  test('executes both subcommands from the written output tree', () => {
    const scriptPath = skillDirScriptPath(path.join(outDir, 'skills/ce-review'))
    exercisePackagedScript(scriptPath, 'claude-code')
    assertRunsUnderRealNode(scriptPath, 'claude-code')
    exercisePipelinePhases(scriptPath, 'claude-code')
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

  test('a stamped digest that no longer matches sources fails --check and names the path', () => {
    // `--check` verifies provenance (the stamped `source-digest:` line against a
    // freshly recomputed digest of the sources), not byte equality of the
    // bundle -- see scripts/generate-ce-review-validator.ts's docblock.
    // Corrupting the stamped digest is the failure mode that models stale
    // committed bytes under that design.
    const original = fs.readFileSync(VALIDATOR_SRC, 'utf8')
    try {
      const corrupted = original.replace(
        /^\/\/ source-digest: [0-9a-f]{64}$/m,
        `// source-digest: ${'0'.repeat(64)}`,
      )
      expect(corrupted).not.toBe(original)
      fs.writeFileSync(VALIDATOR_SRC, corrupted)
      const result = runGenerator(['--check'])

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain(VALIDATOR_REL)
      expect(`${result.stdout}${result.stderr}`).toContain(
        'generated from different sources',
      )
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

  // The gate's intended boundary, pinned explicitly: `--check` proves
  // provenance ("this bundle was built from these sources"), not tamper
  // resistance ("nobody touched this bundle since it was built"). Appending
  // code after the stamped banner is a body edit the gate cannot see -- an
  // accepted residual, not a bug -- while touching the banner/digest line
  // itself is exactly what the gate exists to catch. These two tests pin
  // that boundary so it stays a design decision, not an accident.

  test('accepted residual: appending code after the intact banner still passes --check, because the gate proves provenance, not tamper-resistance', () => {
    const original = fs.readFileSync(VALIDATOR_SRC, 'utf8')
    try {
      const tampered = `${original}\n// appended after generation; the banner and digest line above are untouched\nexport const tamperedBodyMarker = true\n`
      fs.writeFileSync(VALIDATOR_SRC, tampered)
      const result = runGenerator(['--check'])

      expect(result.exitCode, result.stderr).toBe(0)
    } finally {
      fs.writeFileSync(VALIDATOR_SRC, original)
    }
  })

  test('by design: editing the banner text itself (not just the digest value) fails --check, since the banner is the provenance the gate reads', () => {
    const original = fs.readFileSync(VALIDATOR_SRC, 'utf8')
    try {
      const tampered = original.replace(
        '// Run `bun run ce-review-validator:build` to regenerate.',
        '// Run `bun run ce-review-validator:build` to regenerate. (edited)',
      )
      expect(tampered).not.toBe(original)
      fs.writeFileSync(VALIDATOR_SRC, tampered)
      const result = runGenerator(['--check'])

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain(
        'missing its provenance header',
      )
    } finally {
      fs.writeFileSync(VALIDATOR_SRC, original)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Symlinked invocation: the direct-entry guard must not depend on the path
// spelling used to reach the script (macOS `/var` -> `/private/var`).
// ═══════════════════════════════════════════════════════════════════════════

describe('symlinked invocation', () => {
  test('executes when the skill directory is reached through a symlinked path', () => {
    const projectRoot = makeFakeProject()
    const linkRoot = makeTempDir('ce-review-validator-symlink-')
    const linkSkillDir = path.join(linkRoot, 'ce-review')
    fs.symlinkSync(
      path.join(REPO_ROOT, 'skills/ce-review'),
      linkSkillDir,
      'dir',
    )
    const scriptPath = skillDirScriptPath(linkSkillDir)

    expect(fs.existsSync(scriptPath)).toBe(true)
    const result = runNode(scriptPath, ['return'], {
      cwd: projectRoot,
      input: VALID_RETURN,
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('Review return is valid')
  })

  test('importing through a symlinked path stays side-effect-free', () => {
    const linkRoot = makeTempDir('ce-review-validator-symlink-import-')
    const linkScript = path.join(linkRoot, 'validate-review.mjs')
    fs.symlinkSync(VALIDATOR_SRC, linkScript)

    const driver = `
const mod = await import(${JSON.stringify(pathToFileURL(linkScript).href)})
if (typeof Bun !== 'undefined') process.exit(3)
if (typeof mod.runCeReviewValidator !== 'function') process.exit(4)
console.log('node-ok')
`
    const result = spawnSync(NODE_BIN, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      timeout: 30_000,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('node-ok')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Committed bundle byte ceiling: the only thing that surfaces unexpected
// growth reaching the Claude Code layout, where the whole plugin directory
// is copied on install.
// ═══════════════════════════════════════════════════════════════════════════

describe('committed validator byte ceiling', () => {
  test('the committed bundle stays under the growth-surfacing ceiling', () => {
    // Measured 306,686 bytes (~300 KB) at this commit, after the `finalize`
    // phase landed (up from ~207 KB before this work). The ceiling is not a
    // tight budget -- it exists only to catch unexpected growth before it
    // reaches the Claude Code layout, where the whole plugin directory
    // (including this file) is copied on install.
    const GROWTH_CEILING_BYTES = 350_000
    const size = fs.statSync(VALIDATOR_SRC).size
    expect(size).toBeLessThan(GROWTH_CEILING_BYTES)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Repair-class fixture: the prior ghost-ID, omitted-submitter, and
// self-coverage repair failures produced a schema-valid artifact on the
// first authoritative finalization with no parent-written repair pass (U7
// item 4 / plan AE18).
//
// Every envelope fed to `finalize` is helper-produced, not hand-typed: the
// three phases ahead of it (`screen`, `prepare`, `merge`) are driven
// in-process through the real pipeline library functions, in order, and
// only their raw inputs (reviewer returns, the adjudication decision,
// validator lifecycle results, plan assessment, and parent run metadata)
// are hand-written. `finalize` itself then runs under real Node against the
// committed packaged script, and its resulting artifact is written to a
// temp file and validated through the real `artifact` subcommand -- also
// under real Node -- to prove the whole path reaches a conforming artifact
// with no repair.
// ═══════════════════════════════════════════════════════════════════════════

describe('finalize: repair-class fixture reaches a conforming artifact with no repair', () => {
  test('screen -> prepare -> merge in-process, then finalize and artifact under real Node, succeed on the first pass', () => {
    const AUTH_FILE = 'src/auth/session.ts'
    const BILLING_FILE = 'src/billing/invoice.ts'

    function reviewerFinding(overrides: {
      readonly file: string
      readonly line: number
      readonly severity: 'P1' | 'P2' | 'P3'
      readonly requires_verification: boolean
      readonly title: string
      readonly why_it_matters: string
      readonly evidence: readonly string[]
      readonly suggested_fix: string
    }): Record<string, unknown> {
      return {
        autofix_class: 'gated_auto',
        confidence: 0.85,
        owner: 'downstream-resolver',
        pre_existing: false,
        ...overrides,
      }
    }

    // Three-persona run: `correctness` and `maintainability` return real
    // JSON payloads; `security` (risk-critical) never does -- its screen
    // call was unavailable, so the parent records `validation_unavailable`
    // directly rather than inventing a payload (per pipeline-invocation.md's
    // `screen` exit-2 handling).
    const correctnessReturn = {
      findings: [
        reviewerFinding({
          evidence: [
            `${AUTH_FILE}:42 rotates the session token on login only.`,
          ],
          file: AUTH_FILE,
          line: 42,
          requires_verification: false,
          severity: 'P2',
          suggested_fix:
            'Rotate the session token on every privilege change, not just login.',
          title: 'Session token not rotated after privilege change',
          why_it_matters:
            'A stale session token remains valid after a privilege change, letting a revoked or downgraded session act with its old privileges.',
        }),
        reviewerFinding({
          evidence: [
            `${BILLING_FILE}:10 applies the discount after the total is persisted.`,
          ],
          file: BILLING_FILE,
          line: 10,
          requires_verification: true,
          severity: 'P1',
          suggested_fix:
            'Apply the discount before computing the persisted total.',
          title: 'Invoice total computed before discount applied',
          why_it_matters:
            'Persisted invoice totals omit an already-approved discount, overcharging the customer.',
        }),
      ],
      residual_risks: [],
      reviewer: 'correctness',
      testing_gaps: [],
    }

    const maintainabilityReturn = {
      findings: [
        reviewerFinding({
          evidence: [
            `${AUTH_FILE}:42 duplicates rotation logic across three handlers.`,
          ],
          file: AUTH_FILE,
          line: 42,
          requires_verification: false,
          severity: 'P3',
          suggested_fix: 'Extract the rotation logic into one shared helper.',
          title: 'Session rotation logic duplicated across handlers',
          why_it_matters:
            'Duplicated rotation logic drifts silently; a fix applied to one handler is easy to miss in the others.',
        }),
      ],
      residual_risks: [],
      reviewer: 'maintainability',
      testing_gaps: [],
    }

    const correctnessScreen = screenReviewReturn({
      expected_reviewer: 'correctness',
      invoking_harness: 'opencode',
      raw_return: correctnessReturn,
    })
    const maintainabilityScreen = screenReviewReturn({
      expected_reviewer: 'maintainability',
      invoking_harness: 'opencode',
      raw_return: maintainabilityReturn,
    })
    // Constructed directly, never through `screenReviewReturn`: the screen
    // call itself was unavailable for this persona, so there is no raw
    // payload to admit.
    const securityScreen = {
      admitted_findings: [],
      dispatch_outcome: 'validation_unavailable',
      harness: 'opencode',
      residual_risks: [],
      testing_gaps: [],
    }

    const screenResults = [
      { result: correctnessScreen, reviewer: 'correctness' },
      { result: maintainabilityScreen, reviewer: 'maintainability' },
      { result: securityScreen, reviewer: 'security' },
    ]

    const selectedDispatches = [
      {
        dispatch_outcome: 'findings',
        persona: 'correctness',
        selection_surface: [AUTH_FILE, BILLING_FILE],
      },
      {
        dispatch_outcome: 'findings',
        persona: 'maintainability',
        selection_surface: [AUTH_FILE],
      },
      {
        dispatch_outcome: 'validation_unavailable',
        persona: 'security',
        selection_surface: [AUTH_FILE],
      },
    ]

    const prepareResult = prepareReviewCandidates({
      raw_input: {
        screen_results: screenResults,
        selected_dispatches: selectedDispatches,
      },
    })
    if (!prepareResult.ok) {
      throw new Error(
        `fixture setup: prepare rejected: ${JSON.stringify(prepareResult.rejection)}`,
      )
    }
    const prepared = prepareResult.value

    // One candidate group forms on `AUTH_FILE` (correctness + maintainability);
    // `correctness`'s billing finding is a true passthrough singleton needing
    // no decision at all.
    const mergeResult = applyReviewAdjudication({
      decisions: [
        {
          decision_id: 'merged-session-rotation',
          disposition: 'merged',
          evidence: [
            `${AUTH_FILE}:42 shows both the missing rotation and the duplicated logic.`,
          ],
          input_finding_ids: ['correctness#0', 'maintainability#0'],
          line: 42,
          suggested_fix:
            'Rotate the session token on every privilege change, via one shared helper.',
          title: 'Session token not rotated after privilege change',
          why_it_matters:
            'A stale session token remains valid after a privilege change, letting a revoked or downgraded session act with its old privileges.',
        },
      ],
      prepared,
    })
    if (!mergeResult.ok) {
      throw new Error(
        `fixture setup: merge rejected: ${JSON.stringify(mergeResult.rejection)}`,
      )
    }
    const merge = mergeResult.value

    // Sanity on the shape the plan calls for: one merged two-reviewer
    // finding, one singleton, and exactly one validator request (the P1
    // billing singleton -- the merged finding is P2/no-verification, so it
    // never enters the validation band).
    expect(merge.merged_findings).toHaveLength(2)
    expect(merge.validator_requests).toHaveLength(1)
    const singletonRequest = merge.validator_requests[0]
    if (!singletonRequest) {
      throw new Error('fixture setup: expected exactly one validator request')
    }
    const singletonFindingId = singletonRequest.finding_id

    const finalizeInput = {
      dispatch_records: selectedDispatches,
      merge,
      parent_run_metadata: {
        applied_fixes: [],
        branch: 'main',
        harness: 'opencode',
        head_sha: 'b'.repeat(40),
        mode: 'interactive',
        run_id: 'repair-class-fixture-1',
        selected_dispatches: selectedDispatches,
        timestamps: {
          completed_at: '2026-01-01T00:05:00.000Z',
          started_at: '2026-01-01T00:00:00.000Z',
        },
        validation: { reason: 'no autofix applied', status: 'not_attempted' },
      },
      plan_assessment: { results: [], verdict: 'All requirements met.' },
      prepared,
      screen_results: screenResults,
      // One filtered validation result: a validator disproves the P1
      // billing singleton, so it is excluded from risk-coverage eligibility
      // and marked `validated: false` in the artifact.
      validator_lifecycle_results: [
        {
          finding_id: singletonFindingId,
          result: {
            outcome: 'false',
            reason:
              'Reproduction found the discount applied before persistence in the current code.',
          },
        },
      ],
    }

    const finalizeRun = runNode(VALIDATOR_SRC, ['finalize'], {
      input: JSON.stringify(finalizeInput),
    })
    expect(finalizeRun.exitCode, finalizeRun.stderr).toBe(0)
    const parsed = JSON.parse(finalizeRun.stdout) as {
      kind: string
      artifact: { risk_coverage?: readonly unknown[] }
    }
    expect(parsed.kind).toBe('writing')

    // Lost-persona coverage satisfied by cross-persona evidence: `security`
    // was lost, but the merged finding -- owned by `correctness` and
    // `maintainability`, neither of which is `security` -- covers its
    // recorded selection surface.
    expect(parsed.artifact.risk_coverage).toEqual([
      {
        input_finding_id: 'correctness#0',
        persona: 'security',
        satisfied: true,
      },
    ])

    // First-pass artifact validation, no repair: persist the exact bytes
    // `finalize` produced and validate them through the real `artifact`
    // subcommand under real Node.
    const projectRoot = makeFakeProject()
    writeContainedArtifact(projectRoot, JSON.stringify(parsed.artifact))
    const artifactRun = runNode(
      VALIDATOR_SRC,
      ['artifact', '.context/systematic/ce-review/review-summary.json'],
      { cwd: projectRoot },
    )
    expect(artifactRun.exitCode, artifactRun.stderr).toBe(0)
    expect(artifactRun.stdout).toContain('Review artifact is valid')
  })
})
