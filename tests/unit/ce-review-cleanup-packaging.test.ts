// Unit 5 (packaged execution): proves the two builtin-only Node helpers
// (`skills/ce-review/scripts/ensure-ignore.mjs` and
// `skills/ce-review-cleanup/scripts/cleanup.mjs`) actually run -- not just
// exist -- from every distributed shape a consumer can reach them through:
// an OCX producer-only file selection, an OCX cleanup-only file selection,
// a real `npm pack` archive, and the generated Claude Code plugin bundle.
// Every invocation runs against a synthetic fake project in its own temp
// directory; nothing here touches this repository's own `.context/`.
//
// Ownership boundary: this file only exercises existing, already-implemented
// helper/generator behavior (Units 1-4). It adds no new production code.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const REGISTRY_PATH = path.join(REPO_ROOT, 'registry/registry.jsonc')

const ENSURE_IGNORE_REL = 'skills/ce-review/scripts/ensure-ignore.mjs'
const CLEANUP_REL = 'skills/ce-review-cleanup/scripts/cleanup.mjs'
const ENSURE_IGNORE_SRC = path.join(REPO_ROOT, ENSURE_IGNORE_REL)
const CLEANUP_SRC = path.join(REPO_ROOT, CLEANUP_REL)

// ── Real Node binary, resolved before any environment mutation below ───────
//
// `process.execPath` under `bun test` points at the Bun binary, not Node, so
// it must never be used to launch these subprocesses. Resolving once here,
// against the unmodified environment, mirrors
// tests/unit/ce-review-ensure-ignore.test.ts.

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

// ── Shared fixture plumbing ─────────────────────────────────────────────

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

function parseJsonRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) {
    throw new Error(`expected JSON object output, got: ${raw}`)
  }
  return value
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
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const result = spawnSync(NODE_BIN, [scriptPath, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

/** Ephemeral HOME/XDG/Git-config env so real host state can never leak in. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = makeTempDir('ce-review-cleanup-packaging-home-')
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(home, 'nonexistent-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

function createCandidateRun(
  reviewRoot: string,
  name: string,
  options: { readonly ageDays?: number; readonly summary?: unknown } = {},
): void {
  const dir = path.join(reviewRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  if (options.summary !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'review-summary.json'),
      JSON.stringify(options.summary),
    )
  }
  if (options.ageDays !== undefined) {
    const t = daysAgo(options.ageDays)
    const summaryPath = path.join(dir, 'review-summary.json')
    if (fs.existsSync(summaryPath)) fs.utimesSync(summaryPath, t, t)
    fs.utimesSync(dir, t, t)
  }
}

function makeFakeProject(): {
  readonly projectRoot: string
  readonly reviewRoot: string
} {
  const projectRoot = makeTempDir('ce-review-cleanup-packaging-project-')
  const reviewRoot = path.join(
    projectRoot,
    '.context',
    'systematic',
    'ce-review',
  )
  fs.mkdirSync(reviewRoot, { recursive: true })
  return { projectRoot, reviewRoot }
}

// ── Registry (OCX) component reading -- no `as` casts, runtime-narrowed ────

interface RegistryComponent {
  readonly name: string
  readonly type: string
  readonly files?: readonly string[]
  readonly dependencies?: readonly string[]
}

function toRegistryComponent(value: unknown): RegistryComponent | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.name !== 'string' || typeof value.type !== 'string') {
    return undefined
  }
  const files = isStringArray(value.files) ? value.files : undefined
  const dependencies = isStringArray(value.dependencies)
    ? value.dependencies
    : undefined
  return { dependencies, files, name: value.name, type: value.type }
}

function readRegistryComponents(): RegistryComponent[] {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8')
  const parsed: unknown = parseJsonc(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed.components)) {
    throw new Error(
      'registry.jsonc did not parse into the expected { components: [] } shape',
    )
  }
  const components: RegistryComponent[] = []
  for (const entry of parsed.components) {
    const component = toRegistryComponent(entry)
    if (component) components.push(component)
  }
  return components
}

function findComponent(name: string): RegistryComponent {
  const component = readRegistryComponents().find((c) => c.name === name)
  if (!component) {
    throw new Error(`registry component "${name}" not found`)
  }
  return component
}

function copyDeclaredFiles(destRoot: string, files: readonly string[]): void {
  for (const relPath of files) {
    const src = path.join(REPO_ROOT, relPath)
    const dest = path.join(destRoot, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Precondition: real source shape (grounds the negative controls below --
// if the real files already had relative imports, corrupting a copy to
// "introduce" one would prove nothing).
// ═══════════════════════════════════════════════════════════════════════

describe('distributed helper source shape (precondition for negative controls)', () => {
  test('ensure-ignore.mjs has a preserved shebang and no relative or TypeScript-source imports', () => {
    const src = fs.readFileSync(ENSURE_IGNORE_SRC, 'utf8')
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(src).not.toMatch(/from\s+['"]\.\.?\//)
    expect(src).not.toMatch(/require\(/)
    expect(src).not.toMatch(/from\s+['"][^'"]*\.ts['"]/)
  })

  test('cleanup.mjs has a preserved shebang and no relative or TypeScript-source imports', () => {
    const src = fs.readFileSync(CLEANUP_SRC, 'utf8')
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(src).not.toMatch(/from\s+['"]\.\.?\//)
    expect(src).not.toMatch(/require\(/)
    expect(src).not.toMatch(/from\s+['"][^'"]*\.ts['"]/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 1: OCX producer-only file selection (ce-review component)
// ═══════════════════════════════════════════════════════════════════════

describe('OCX producer-only file selection (ce-review component)', () => {
  test('declared files include the ignore helper and not the cleanup helper', () => {
    const component = findComponent('ce-review')
    expect(component.files ?? []).toContain(ENSURE_IGNORE_REL)
    expect(component.files ?? []).not.toContain(CLEANUP_REL)
  })

  test('copying only the manifest-declared files and running the helper protects a synthetic Git project', () => {
    const component = findComponent('ce-review')
    if (!component.files) throw new Error('ce-review declares no files')
    const consumerRoot = makeTempDir('ocx-ce-review-only-')
    copyDeclaredFiles(consumerRoot, component.files)
    const helperPath = path.join(consumerRoot, ENSURE_IGNORE_REL)
    expect(fs.existsSync(helperPath)).toBe(true)

    const { projectRoot } = makeFakeProject()
    const env = isolatedEnv()
    const init = spawnSync('git', ['init', '-q'], { cwd: projectRoot, env })
    expect(init.status).toBe(0)

    const run = runNode(helperPath, ['--root', projectRoot], { env })
    expect(run.exitCode).toBe(0)
    expect(parseJsonRecord(run.stdout).status).toBe('protected')

    const gitignoreBytes = fs.readFileSync(
      path.join(projectRoot, '.context/.gitignore'),
      'utf8',
    )
    expect(gitignoreBytes).toBe('/systematic/ce-review/\n')

    const check = spawnSync(
      'git',
      [
        'check-ignore',
        '--no-index',
        '-q',
        '--',
        '.context/systematic/ce-review/',
      ],
      { cwd: projectRoot, env },
    )
    expect(check.status).toBe(0)
  })

  test('negative control: a registry entry missing the helper path loses it from the copied tree, and invoking the missing path fails loudly', () => {
    const component = findComponent('ce-review')
    if (!component.files) throw new Error('ce-review declares no files')
    const driftedFiles = component.files.filter((f) => f !== ENSURE_IGNORE_REL)
    expect(driftedFiles.length).toBeLessThan(component.files.length)

    const consumerRoot = makeTempDir('ocx-ce-review-drifted-')
    copyDeclaredFiles(consumerRoot, driftedFiles)
    const missingHelperPath = path.join(consumerRoot, ENSURE_IGNORE_REL)
    expect(fs.existsSync(missingHelperPath)).toBe(false)

    const { projectRoot } = makeFakeProject()
    const run = runNode(missingHelperPath, ['--root', projectRoot])
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr).toMatch(/Cannot find module|ENOENT/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 2: OCX cleanup-only file selection (ce-review-cleanup component)
// ═══════════════════════════════════════════════════════════════════════

describe('OCX cleanup-only file selection (ce-review-cleanup component)', () => {
  test('declared files include only the cleanup helper, with no ce-review cross-dependency', () => {
    const component = findComponent('ce-review-cleanup')
    expect(component.files ?? []).toContain(CLEANUP_REL)
    expect(component.files ?? []).not.toContain(ENSURE_IGNORE_REL)
    expect(component.dependencies ?? []).not.toContain('ce-review')
  })

  test('copying only the manifest-declared files runs a real preview against synthetic old runs, with no evidence canary in stdout/stderr', () => {
    const component = findComponent('ce-review-cleanup')
    if (!component.files) {
      throw new Error('ce-review-cleanup declares no files')
    }
    const consumerRoot = makeTempDir('ocx-ce-review-cleanup-only-')
    copyDeclaredFiles(consumerRoot, component.files)
    const helperPath = path.join(consumerRoot, CLEANUP_REL)
    expect(fs.existsSync(helperPath)).toBe(true)

    const { projectRoot, reviewRoot } = makeFakeProject()
    const canary = 'CANARY-MARKER-8f3c2b91'
    createCandidateRun(reviewRoot, 'old-run-a', {
      ageDays: 45,
      summary: { note: canary, run_status: 'completed', schema_version: 1 },
    })
    createCandidateRun(reviewRoot, 'recent-run-b', { ageDays: 2 })

    const preview = runNode(helperPath, [
      'preview',
      '--root',
      projectRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(preview.exitCode).toBe(0)
    expect(preview.stdout).not.toContain(canary)
    expect(preview.stderr).not.toContain(canary)
    const response = parseJsonRecord(preview.stdout)
    expect(response.result).toBe('preview')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 3: real `npm pack` archive, extracted once and reused
// ═══════════════════════════════════════════════════════════════════════

describe('npm-packed archive: real execution from an extracted, isolated copy', () => {
  let extractDir: string

  beforeAll(() => {
    const packDestDir = makeTempDir('ce-review-cleanup-packaging-npmpack-')
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
    if (!tarballName) {
      throw new Error('npm pack produced no tarball filename')
    }
    const tarballPath = path.join(packDestDir, tarballName)

    extractDir = makeTempDir('ce-review-cleanup-packaging-npmextract-')
    const extract = spawnSync('tar', ['xzf', tarballPath, '-C', extractDir], {
      timeout: 30_000,
    })
    if (extract.status !== 0) {
      throw new Error(
        `tar extraction failed: ${extract.stderr?.toString() ?? ''}`,
      )
    }
  }, 120_000)

  test('tarball contains both helpers at their shipped relative paths', () => {
    expect(
      fs.existsSync(path.join(extractDir, 'package', ENSURE_IGNORE_REL)),
    ).toBe(true)
    expect(fs.existsSync(path.join(extractDir, 'package', CLEANUP_REL))).toBe(
      true,
    )
  })

  test('packaged ensure-ignore.mjs protects a synthetic Git project with the exact entry, isolated from host HOME/XDG/Git config', () => {
    const helperPath = path.join(extractDir, 'package', ENSURE_IGNORE_REL)
    const { projectRoot } = makeFakeProject()
    const env = isolatedEnv()
    const init = spawnSync('git', ['init', '-q'], { cwd: projectRoot, env })
    expect(init.status).toBe(0)

    const run = runNode(helperPath, ['--root', projectRoot], { env })
    expect(run.exitCode).toBe(0)
    expect(parseJsonRecord(run.stdout).status).toBe('protected')
    expect(
      fs.readFileSync(path.join(projectRoot, '.context/.gitignore'), 'utf8'),
    ).toBe('/systematic/ce-review/\n')
  })

  test('packaged cleanup.mjs preview+execute deletes only the expected old run and leaves the root and unrelated runs intact', () => {
    const helperPath = path.join(extractDir, 'package', CLEANUP_REL)
    const { projectRoot, reviewRoot } = makeFakeProject()
    const canary = 'CANARY-MARKER-91cd7a02'
    createCandidateRun(reviewRoot, 'old-run', {
      ageDays: 45,
      summary: { note: canary, run_status: 'completed', schema_version: 1 },
    })
    createCandidateRun(reviewRoot, 'recent-run', { ageDays: 2 })

    const preview = runNode(helperPath, [
      'preview',
      '--root',
      projectRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(preview.exitCode).toBe(0)
    expect(preview.stdout).not.toContain(canary)
    const previewResponse = parseJsonRecord(preview.stdout)
    if (typeof previewResponse.token !== 'string') {
      throw new Error('expected preview to return a token for the selection')
    }
    const token = previewResponse.token

    const execute = runNode(helperPath, [
      'execute',
      '--root',
      projectRoot,
      '--ack-offline',
      '--token',
      token,
    ])
    expect(execute.exitCode).toBe(0)
    expect(execute.stdout).not.toContain(canary)
    const executeResponse = parseJsonRecord(execute.stdout)
    expect(executeResponse.result).toBe('deleted')

    expect(fs.existsSync(path.join(reviewRoot, 'old-run'))).toBe(false)
    expect(fs.existsSync(path.join(reviewRoot, 'recent-run'))).toBe(true)
    expect(fs.existsSync(reviewRoot)).toBe(true)
  })

  test('packaged cleanup.mjs static help runs with no --root and no scan, from the real extracted archive', () => {
    const helperPath = path.join(extractDir, 'package', CLEANUP_REL)
    const help = runNode(helperPath, ['help'])
    expect(help.exitCode).toBe(0)
    const helpResponse = parseJsonRecord(help.stdout)
    expect(helpResponse.result).toBe('help')
    expect(help.stdout).not.toContain(extractDir)
  })

  test('Pi native skill-relative-path discovery resolves from the same extracted tarball (does not claim a real Pi host was exercised)', () => {
    const pkgRaw = fs.readFileSync(
      path.join(extractDir, 'package/package.json'),
      'utf8',
    )
    const pkg = parseJsonRecord(pkgRaw)
    if (!isRecord(pkg.pi)) {
      throw new Error('expected package.json pi manifest object')
    }
    const piSkills = pkg.pi.skills
    if (!isStringArray(piSkills)) {
      throw new Error('expected pi.skills to be a string array')
    }
    expect(piSkills).toContain('./skills')

    // Resolve the same relative path the SKILL_DIR anchor in
    // skills/ce-review-cleanup/SKILL.md uses ("$SKILL_DIR/scripts/cleanup.mjs"),
    // rooted at the skill's own directory inside the packed tree.
    const cleanupSkillDir = path.join(
      extractDir,
      'package/skills/ce-review-cleanup',
    )
    const cleanupHelperViaRelativeAnchor = path.join(
      cleanupSkillDir,
      'scripts/cleanup.mjs',
    )
    expect(fs.existsSync(cleanupHelperViaRelativeAnchor)).toBe(true)

    // Real execution through that resolved path (not just fs.existsSync):
    // an existing-but-empty root with no `.context/systematic/ce-review`
    // reaches the helper's own root-resolution logic and reports
    // `root-missing`, proving the process actually ran the module rather
    // than merely finding the file.
    const emptyRoot = makeTempDir('pi-relative-root-')
    const run = runNode(cleanupHelperViaRelativeAnchor, [
      'preview',
      '--root',
      emptyRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(run.exitCode).toBe(0)
    expect(parseJsonRecord(run.stdout).result).toBe('root-missing')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Channel 4: Claude Code generated bundle -- generated exactly once
// ═══════════════════════════════════════════════════════════════════════

describe('Claude Code packaged bytes and execution (single generated fixture)', () => {
  let outDir: string

  beforeAll(() => {
    const placeholderValidatorBundle = Buffer.from(
      'placeholder validator bundle',
    )
    const files = generatePluginFiles(REPO_ROOT, placeholderValidatorBundle)
    outDir = makeTempDir('ce-review-cleanup-packaging-cc-')
    writePluginFiles(files, outDir)
  }, 60_000)

  test('both helpers are byte-identical to source (namespace translation never touches .mjs)', () => {
    const ccEnsureIgnore = fs.readFileSync(path.join(outDir, ENSURE_IGNORE_REL))
    const ccCleanup = fs.readFileSync(path.join(outDir, CLEANUP_REL))
    expect(ccEnsureIgnore.equals(fs.readFileSync(ENSURE_IGNORE_SRC))).toBe(true)
    expect(ccCleanup.equals(fs.readFileSync(CLEANUP_SRC))).toBe(true)
  })

  test('the generated bundle executes both helpers for real from the written output tree', () => {
    const helperPath = path.join(outDir, ENSURE_IGNORE_REL)
    const { projectRoot } = makeFakeProject()
    const env = isolatedEnv()
    const init = spawnSync('git', ['init', '-q'], { cwd: projectRoot, env })
    expect(init.status).toBe(0)
    const run = runNode(helperPath, ['--root', projectRoot], { env })
    expect(run.exitCode).toBe(0)
    expect(parseJsonRecord(run.stdout).status).toBe('protected')

    const cleanupHelperPath = path.join(outDir, CLEANUP_REL)
    const { projectRoot: cleanupProject, reviewRoot } = makeFakeProject()
    createCandidateRun(reviewRoot, 'old-run', { ageDays: 45 })
    const preview = runNode(cleanupHelperPath, [
      'preview',
      '--root',
      cleanupProject,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(preview.exitCode).toBe(0)
    expect(parseJsonRecord(preview.stdout).result).toBe('preview')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Negative controls: corrupt a distributed COPY only, never real source.
// Each control is paired with a positive counterpart (either above, or
// inline) so a broken control cannot masquerade as a passing suite.
// ═══════════════════════════════════════════════════════════════════════

describe('negative controls: distributed-copy corruption (never mutates real source)', () => {
  test('removing the helper from a distributed copy makes invocation fail loudly, not silently pass', () => {
    const component = findComponent('ce-review-cleanup')
    if (!component.files) {
      throw new Error('ce-review-cleanup declares no files')
    }
    const consumerRoot = makeTempDir('negative-removed-helper-')
    copyDeclaredFiles(consumerRoot, component.files)
    const helperPath = path.join(consumerRoot, CLEANUP_REL)
    // Control: the helper is present and runnable before removal.
    expect(fs.existsSync(helperPath)).toBe(true)
    const before = runNode(helperPath, [
      'preview',
      '--root',
      consumerRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(before.exitCode).toBe(0)

    fs.rmSync(helperPath)
    const after = runNode(helperPath, [
      'preview',
      '--root',
      consumerRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(after.exitCode).not.toBe(0)
    expect(after.stderr).toMatch(/Cannot find module|ENOENT/)
  })

  test('an injected missing relative import after the preserved shebang fails at module resolution, not at parse time', () => {
    const consumerRoot = makeTempDir('negative-missing-import-')
    fs.mkdirSync(consumerRoot, { recursive: true })
    const original = fs.readFileSync(CLEANUP_SRC, 'utf8')
    const shebangEnd = original.indexOf('\n') + 1
    const shebang = original.slice(0, shebangEnd)
    const body = original.slice(shebangEnd)
    const corrupted = `${shebang}import { nothingHere } from './does-not-exist-negative-control.mjs'\n${body}`
    const corruptedPath = path.join(consumerRoot, 'cleanup-corrupted.mjs')
    fs.writeFileSync(corruptedPath, corrupted)

    const corruptedRun = runNode(corruptedPath, [
      'preview',
      '--root',
      consumerRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(corruptedRun.exitCode).not.toBe(0)
    expect(corruptedRun.stderr).toMatch(
      /ERR_MODULE_NOT_FOUND|Cannot find module/,
    )
    expect(corruptedRun.stderr).not.toMatch(/SyntaxError/)

    // Control: an unmodified copy of the same real source (no relative
    // imports) parses and runs cleanly from the same directory.
    const cleanCopyPath = path.join(consumerRoot, 'cleanup-clean.mjs')
    fs.writeFileSync(cleanCopyPath, original)
    const cleanRun = runNode(cleanCopyPath, [
      'preview',
      '--root',
      consumerRoot,
      '--age',
      '30d',
      '--ack-offline',
    ])
    expect(cleanRun.exitCode).toBe(0)
  })

  test('a nonexistent Node binary surfaces an actionable ENOENT rather than a false-positive pass', () => {
    const result = spawnSync(
      'definitely-not-a-real-node-binary-xyz',
      [CLEANUP_SRC],
      { encoding: 'utf8' },
    )
    if (!result.error) {
      throw new Error(
        'expected spawnSync to report an error for a nonexistent binary',
      )
    }
    // Bun's spawnSync reports "Executable not found in $PATH", while Node's
    // reports an ENOENT error code -- either is an actionable, loud failure,
    // never a silent success.
    expect(result.error.message).toMatch(/ENOENT|not found/i)
  })
})
